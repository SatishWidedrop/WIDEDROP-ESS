# Widedrop ESS — REST API Contract

**Status:** authoritative design contract. An implementer follows this document and
makes no further interface decisions. Where a decision was previously left open, §18 now
marks it `RESOLVED` with the decision, or `OPEN` with the owner and the default that holds
until they decide — an implementer never has to invent one.

**Companion documents (read together, no duplication of truth):**

| Document                  | Owns                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `docs/DATA-MODEL.md`      | Tables, columns, enums, state machines, guard catalogue, query-pattern appendix                                                  |
| `docs/SECURITY.md`        | Threat model, auth primitives, RBAC/ABAC matrix, crypto, masking, rate limits, headers                                           |
| `docs/WORKFLOWS.md`       | Which state transitions exist, their guards, notifications and emails — the authority this contract binds to endpoints in §13.19 |
| `design/DESIGN-SYSTEM.md` | Visual language, nav model, empty-state pattern, locale rules                                                                    |
| `design/prototype/*`      | The UI/UX source of truth                                                                                                        |
| **this document**         | The wire: paths, verbs, schemas, statuses, headers, error codes, idempotency, pagination, and the screen→endpoint map            |

Where this document names a persisted field it uses the exact `table.column` spelling
from `docs/DATA-MODEL.md`. Where a response field is computed it is annotated
`= <formula>`. **No response field exists that is not either a persisted column, a
deterministic function of persisted columns, or a reference-data label.** There is no
endpoint anywhere in this contract that returns a sample, seeded-for-demo, or
placeholder operational value.

---

## 1. Foundations

### 1.1 Base path and versioning

| Property             | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base path            | `/api/v1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Production origin    | `https://api-ess.widedrop.com`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Staging origin       | `https://api-ess-staging.widedrop.com`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Media type           | `application/json; charset=utf-8` only (plus `multipart/form-data` on the two upload routes in §12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Versioning policy    | The major version is in the path. A breaking change (removing a field, narrowing a type, changing a status code, changing an enum's meaning) requires `/api/v2`. Adding an optional request field, adding a response field, or adding an enum **value** is non-breaking and ships in `v1`.                                                                                                                                                                                                                                                                                      |
| Enum growth          | Clients MUST tolerate unknown enum values by falling back to the `gray` tone and the raw label. The server never removes an enum value.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Trailing slashes     | Rejected. `/api/v1/leave-requests/` → `404`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Unknown routes       | `404 NOT_FOUND` with the standard envelope; the API never serves an HTML error page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Unregistered parsers | `text/plain`, `application/x-www-form-urlencoded` and `application/xml` parsers are not registered (`SECURITY.md` §5.1) ⇒ `415 UNSUPPORTED_MEDIA_TYPE`.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CORS allowlist       | Exactly two origins, read once at boot from `ALLOWED_ORIGINS` (comma-separated, no wildcard, no regex, boot fails when empty): production `https://ess.widedrop.com`, staging `https://ess-staging.widedrop.com`. `https://widedrop.com` — the Netlify marketing site — is **not** an allowed origin and never calls this API (Directive 10). Comparison is byte-equality on the full origin.                                                                                                                                                                                   |
| Preflight            | `OPTIONS` is answered by the CORS plugin alone, **before** authentication, and only for an allowlisted `Origin`: `Access-Control-Allow-Origin: <the echoed origin>` (never `*`), `-Allow-Credentials: true`, `-Allow-Methods: GET, POST, PUT, PATCH, DELETE`, `-Allow-Headers: Authorization, Content-Type, X-Request-Id, Idempotency-Key, If-Match, X-WD-CSRF`, `-Max-Age: 600`. A preflight from any other origin returns `204` with **no** `Access-Control-*` header, which the browser then blocks. `OPTIONS` is the only method exempt from the §4.1 permission assertion. |

Path style: plural, kebab-case nouns (`/leave-requests`, `/payroll/cycles`,
`/help-desk/tickets`). Sub-resources nest one level at most. State changes are
`POST /<collection>/:id/<verb>` where the verb is the state-machine transition name in
kebab-case (`/approve`, `/reject`, `/withdraw`, `/acknowledge`, `/publish`, `/submit`).

### 1.2 The self-scoped namespace

Every employee-facing read of the actor's own data lives under `/api/v1/me/**`. This is
not cosmetic: routes under `/me` take **no** employee identifier of any kind, in the path,
query or body. The subject is always `actor.employeeId`, derived from the access token's
`sub` → `employee.app_user_id`. A request that supplies `employeeId` anywhere under `/me`
fails `.strict()` validation with `400 VALIDATION_FAILED` and is audited as a
`SECURITY.SUSPICIOUS_PAYLOAD` signal (`SECURITY.md` §4.6).

Back-office surfaces that legitimately name another employee live under
`/api/v1/hr/**`, `/api/v1/payroll/**`, `/api/v1/manager/**` and `/api/v1/admin/**`, and
every one of them resolves its scope predicate into the query rather than fetching and
then checking.

### 1.3 Request headers

| Header                                            | Required                                                         | Notes                                                                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer <access JWT>`              | Yes, except on the five public routes (§4.1)                     | Access token only. Never a refresh token, never in a query string.                                                                                      |
| `Content-Type: application/json`                  | On every request with a body                                     | Missing/other ⇒ `415`.                                                                                                                                  |
| `Accept: application/json`                        | Optional                                                         | `*/*` accepted. Anything else ⇒ `406 NOT_ACCEPTABLE`.                                                                                                   |
| `X-Request-Id: <uuid v4>`                         | Optional                                                         | Echoed in the response and written to `audit_event.request_id`. Absent ⇒ the server mints one. A non-uuid value is ignored and replaced (never echoed). |
| `Idempotency-Key: <1–128 chars, `[A-Za-z0-9_-]`>` | On the endpoints listed in §8.2                                  | Absent on a required endpoint ⇒ `400 IDEMPOTENCY_KEY_REQUIRED`.                                                                                         |
| `If-Match: "<row_version>"`                       | On `PATCH`/`PUT` of resources carrying `row_version` (§9)        | Absent ⇒ `428 PRECONDITION_REQUIRED`. Stale ⇒ `409 VERSION_CONFLICT`.                                                                                   |
| `X-WD-CSRF: <nonce>.<hmac>`                       | On `POST /auth/refresh`, `/auth/logout`, `/auth/logout-all` only | The cookie-authenticated surface. Value echoes the `__Host-wd_csrf` cookie (`SECURITY.md` §3.5).                                                        |
| `Origin`                                          | On every unsafe method                                           | Must exactly equal an allowlisted origin. Absent or mismatched ⇒ `403 CSRF_ORIGIN_REJECTED`.                                                            |
| `Sec-Fetch-Site` / `-Mode` / `-Dest`              | Enforced when present                                            | `same-site`/`same-origin` · `cors` · `empty`. Otherwise `403 CSRF_FETCH_METADATA_REJECTED`.                                                             |
| Cookie `__Host-wd_rt`                             | Only read by `/auth/refresh`, `/auth/logout`, `/auth/logout-all` | Every other route ignores cookies entirely.                                                                                                             |

### 1.4 Response headers

| Header                                                                                                                                                                                                                                                        | When                                                           | Value                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `X-Request-Id`                                                                                                                                                                                                                                                | Always                                                         | The correlation id. The SPA shows it in the error banner's "reference" line so a support ticket can be joined to `audit_event.request_id`. |
| `Cache-Control: no-store` + `Pragma: no-cache`                                                                                                                                                                                                                | Always                                                         | Global `onSend` hook; not per-route (`SECURITY.md` §6.6).                                                                                  |
| `Vary: Origin, Authorization`                                                                                                                                                                                                                                 | Always                                                         |                                                                                                                                            |
| `Content-Type: application/json; charset=utf-8`                                                                                                                                                                                                               | On every body                                                  |                                                                                                                                            |
| `ETag: "<row_version>"`                                                                                                                                                                                                                                       | On single-resource `GET`/`POST`/`PATCH` of versioned resources | Opaque strong validator; the value is the integer `row_version`.                                                                           |
| `Location`                                                                                                                                                                                                                                                    | On `201`                                                       | Absolute path of the created resource.                                                                                                     |
| `RateLimit-Limit` / `-Remaining` / `-Reset`                                                                                                                                                                                                                   | Always on rate-limited routes                                  |                                                                                                                                            |
| `Retry-After`                                                                                                                                                                                                                                                 | On `429`, `423`, `503`, and `409 IDEMPOTENCY_IN_PROGRESS`      | Integer seconds.                                                                                                                           |
| `Idempotency-Replayed: true`                                                                                                                                                                                                                                  | On a replayed idempotent response                              | Absent on the first execution.                                                                                                             |
| `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-site`                                                                                                                         | Always                                                         | `SECURITY.md` §6.4.                                                                                                                        |
| `Strict-Transport-Security: max-age=63072000; includeSubDomains`                                                                                                                                                                                              | Always                                                         | `SECURITY.md` §6.2. `preload` deliberately absent.                                                                                         |
| `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox`                                                                                                                                                               | Always                                                         | The API serves JSON only; this neutralises any response a browser is tricked into rendering as a document.                                 |
| `Cross-Origin-Opener-Policy: same-origin`                                                                                                                                                                                                                     | Always                                                         |                                                                                                                                            |
| `Access-Control-Allow-Origin: <echoed allowlisted origin>`, `Access-Control-Allow-Credentials: true`, `Access-Control-Expose-Headers: X-Request-Id, ETag, Location, Retry-After, Idempotency-Replayed, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset` | When `Origin` is allowlisted (§1.1)                            | Never `*`; absent entirely otherwise.                                                                                                      |
| `Server` / `X-Powered-By`                                                                                                                                                                                                                                     | Never                                                          | Removed.                                                                                                                                   |

### 1.5 Representation rules

| Concern                             | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Money**                           | Always an **integer of minor units (paise)** in a field suffixed `…Minor`, plus a sibling `currency` (`"INR"`). The API never sends a formatted string, a float, or a rupee value — **including inside `emptyState.params`, `/search` results, `notification` payloads and `email_outbox.template_data`**. Every `…Minor` value is asserted `Number.isSafeInteger` (                                                                                                                                  | v   | ≤ 2^53−1) by the response schema; a stored value outside that range is `500 INTEGRITY_ASSERTION_FAILED`, never a rounded number. `₹86,000` is produced by the SPA as `'₹' + Math.round(minor/100).toLocaleString('en-IN')` (`DESIGN-SYSTEM.md` §10). |
| **Dates**                           | `YYYY-MM-DD` (calendar dates, e.g. `payslip.pay_date`).                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Instants**                        | RFC 3339 UTC with `Z` (e.g. `2026-08-31T12:04:11.238Z`).                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Day counts**                      | JSON numbers with at most 2 decimals (`numeric(5,2)` columns): `14.5`, `0.5`.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Percentages**                     | Integers `0–100` when displayed as a bar width; ratios as `numeric` only where the DB stores a rate.                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Ids**                             | UUID v4/v7 strings. Business references (`WDT-PS-2608-1847`, `EXP-2291`, `HD-4821`) are separate display fields, never used as path ids.                                                                                                                                                                                                                                                                                                                                                              |
| **Enums**                           | `SCREAMING_SNAKE_CASE` exactly as the Postgres enum (`ess_*`). The server also sends a rendered `label` and a `tone` (`GREEN`/`AMBER`/`RED`/`BLUE`/`GRAY`) wherever the UI shows a chip, so the SPA never maps status→copy itself.                                                                                                                                                                                                                                                                    |
| **Absent vs null vs zero**          | **Load-bearing.** `null` = the fact is persisted as unknown/not-applicable → the UI renders `—`. **Field omitted** = the actor is not entitled to it, or the satellite row does not exist → the UI omits the element. `0` = a measured zero and is rendered as `0`. The API never substitutes `0` for a missing measurement (Core Principle 2 / `DESIGN-SYSTEM.md` §8).                                                                                                                               |
| **Empty collections**               | `{"data": [], "page": {...}}` with `200`. **Never** `404`, never an error, never sample rows. Where the emptiness has a knowable cause the collection carries a sibling `emptyState` object (§1.6).                                                                                                                                                                                                                                                                                                   |
| **Masking**                         | Applied server-side in the DTO mapper (`SECURITY.md` §7.5). A masked field is sent as `{"masked": "AXYPR••••K", "isMasked": true}`; the full value is a different field on a different, step-up-guarded endpoint. A masked value is never accepted as write input.                                                                                                                                                                                                                                    |
| **Strings**                         | UTF-8, NFC-normalised on write, `.trim()`-ed, explicit `.max()` on every field.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Booleans**                        | Never tri-state; use `null` on a nullable column only where the DB column is nullable.                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Unknown request keys**            | Rejected (`.strict()`), not stripped ⇒ `400 VALIDATION_FAILED`.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Enum ordering is never semantic** | No query, guard, computed field or DTO in this contract compares a Postgres enum with `<`, `<=`, `>` or `>=`. `ess_payroll_cycle_status` and its siblings are ordered for readability only, and a future `ALTER TYPE … ADD VALUE` would silently change the meaning of such a comparison (`DATA-MODEL.md` §20.9). Every "has reached stage X" test is an explicit `IN (…)` list, and every such list is written out in this document (§13.6.1).                                                       |
| **Server-composed labels**          | Any response field that is a sentence or a joined label (`rangeLabel`, `daysLabel`, `metaLabel`, `subLabel`, `subHeader`, `meta`, `purposeLabel`, `requestedLabel`, `disabledReason`, `coverLabel`, `payableLabel`, `authorByline`, `cardSubLabel`, `firstResponseSlaLabel`) is composed **server-side** from a `ui_copy` template plus persisted parameters, using the formatters of §12.18 in `organization.locale`/`.timezone`. It is never a literal in a handler and never assembled by the SPA. |

### 1.6 The `emptyState` contract

Directive 9 requires every screen to stay correct and explanatory with zero data. Copy is
**not** invented by the SPA. Any collection or metric endpoint whose result is empty for a
knowable reason returns:

```jsonc
{
  "data": [],
  "page": { "limit": 25, "nextCursor": null, "hasMore": false },
  "emptyState": {
    "code": "PAYSLIPS_CYCLE_IN_PROGRESS", // stable, enumerated — Appendix C (§16)
    "title": "No payslips yet",
    "message": "August 2026 payroll is being processed.",
    "params": {
      "periodLabel": "August 2026",
      "stageKey": "ATTENDANCE_SUBMITTED",
      "stageLabel": "Attendance submitted",
    },
  },
}
```

Rules:

1. `title`/`message` are resolved server-side from `ui_copy` (`DATA-MODEL.md` §4.7) with
   `params` interpolated from persisted values. They are never hardcoded in the SPA.
2. `params` values are themselves persisted facts (a `payroll_cycle.status`, a
   `benefit_plan_year.enrolment_window_opens_on`, a `fiscal_year.label`). Nothing is guessed.
   `params` carries **no money value in any form** — not an integer, not a string — and no
   raw back-office enum on an employee-facing route. Where a workflow stage must be named to
   an employee it travels as the pair `stageKey` (one of the seven keys of §13.6.1, for the
   SPA's `switch`) + `stageLabel` (its `ui_copy` label). Internal and failure states
   (`VALIDATING`, `VALIDATION_FAILED`, `CALCULATING`, `CANCELLED`) collapse to
   `stageKey: "IN_PROGRESS"` before they reach an employee — an employee is never told that
   payroll validation failed.
3. `emptyState` is **omitted** when the collection is non-empty, and also omitted when the
   emptiness has no explanation beyond "there is nothing" — in that case the SPA renders its
   generic designed empty state for that surface.
4. A metric object that has no underlying row returns `{"valueMinor": null, "subLabel": {...}}`;
   the SPA renders `—` with the sub-label. It never renders `₹0`.
5. `emptyState` behaves identically on page/limit collections; the `page` object keeps its
   own shape (`total: 0`, `totalPages: 0`). A `404` is never used to express emptiness.
6. A code is valid only if it appears in Appendix C (§16) **and** has seeded `ui_copy` keys
   `empty.<lower_snake_code>.title` and `.message`. CI invariant 12 (§17) fails the build
   otherwise, so an un-catalogued code cannot ship.

The enumerated `emptyState.code` values are listed with their owning endpoints throughout §13
and collected in **Appendix C (§16)**. Appendix D (§17) is the CI-invariant list.

---

## 2. Error envelope and code catalogue

### 2.1 Envelope

**Every** non-2xx response, without exception, is exactly:

```jsonc
{
  "error": {
    "code": "GUARD_FAILED",
    "message": "Attendance for August 2026 cannot be submitted until Accounts locks payroll inputs.",
    "details": { "guardKey": "attendance.payroll_inputs_locked", "cycleStatus": "INPUTS_OPEN" },
    "requestId": "0f2c1b6e-6f1a-4c0a-9a2c-6f3f6b2a1c77",
  },
}
```

| Field       | Type   | Rule                                                                                                                                                                                                                                                    |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`      | string | From the closed catalogue in §2.3. Stable across versions; the SPA branches on it.                                                                                                                                                                      |
| `message`   | string | Human-readable, **safe to display**, ≤ 300 chars. Sourced from `ui_copy` where it is user-facing. Contains no identifiers the caller may not already see, no stack frames, no SQL, no table names, no internal hostnames, no third-party provider text. |
| `details`   | object | Optional, **allowlisted per code** (§2.3). Never free-form. Never echoes a submitted value — a submitted value may be a password, a PAN or a salary (`SECURITY.md` §5.1).                                                                               |
| `requestId` | uuid   | Always present; equals the `X-Request-Id` response header.                                                                                                                                                                                              |

`5xx` responses carry a fixed generic `message` ("Something went wrong on our side.") and
**no** `details`. The real cause is in the structured log keyed by `requestId` only.

### 2.2 `400` vs `422` vs `409` — the discipline

| Status | Meaning                                                                                                                     | SPA behaviour                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | The request does not match the schema. A client bug.                                                                        | Generic error toast + `requestId`.                                                                                                             |
| `422`  | Schema-valid but business-invalid (balance exceeded, window closed, weak password).                                         | Rendered **inline in the form's error banner** — the prototype's `lfErr`/`efErr`/`tfErr` pattern. `details` names the field where one applies. |
| `409`  | The resource's _state_ forbids the operation, or a concurrency/uniqueness collision.                                        | Inline banner + the affected object is refetched.                                                                                              |
| `403`  | Authenticated, object visible, action not permitted.                                                                        | Action control hidden/disabled after the refetch.                                                                                              |
| `404`  | Object does not exist **or is outside the actor's scope**. The two are deliberately indistinguishable (`SECURITY.md` §4.6). | "Not found" state.                                                                                                                             |

### 2.3 Code catalogue

Codes are grouped by status. `details` keys are exhaustive — an implementation that adds a
key adds it here first.

**400 Bad Request**

| Code                       | Meaning                                         | `details`                                         |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| `VALIDATION_FAILED`        | Zod schema failure                              | `fieldErrors: { "<path>": ["<static message>"] }` |
| `MALFORMED_JSON`           | Body is not parseable JSON                      | —                                                 |
| `SUSPICIOUS_PAYLOAD`       | `__proto__`/`constructor.prototype` in the body | —                                                 |
| `IDEMPOTENCY_KEY_REQUIRED` | Required `Idempotency-Key` absent               | `route`                                           |
| `INVALID_CURSOR`           | Pagination cursor fails HMAC or is malformed    | —                                                 |
| `UNSUPPORTED_SORT`         | `sort` value not in the route's allowlist       | `allowed: string[]`                               |

**401 Unauthorized** — all of these clear no state and are never cached.

| Code                    | Meaning                                                                                   | `details`                                |
| ----------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| `UNAUTHENTICATED`       | No `Authorization` header, or it is malformed                                             | —                                        |
| `INVALID_CREDENTIALS`   | Wrong email or password. **Identical response for an unknown email** (`SECURITY.md` §2.4) | —                                        |
| `TOKEN_EXPIRED`         | `exp` passed                                                                              | —                                        |
| `TOKEN_INVALID`         | Signature, `alg`, `iss`, `aud` or `kid` rejected                                          | —                                        |
| `TOKEN_STALE`           | `ver` ≠ `app_user.token_epoch` — roles/password changed                                   | —                                        |
| `SESSION_REVOKED`       | `sid` family revoked, or refresh reuse detected                                           | —                                        |
| `MFA_CHALLENGE_INVALID` | `mfaToken` missing, expired or not bound to this login                                    | —                                        |
| `MFA_CODE_INVALID`      | TOTP/recovery code rejected (also covers replayed step counters)                          | `attemptsRemaining` (int, only when > 0) |
| `RESET_TOKEN_INVALID`   | Password-reset token unknown, expired or used                                             | —                                        |

**403 Forbidden**

| Code                           | Meaning                                                                       | `details`                                                                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTHZ_DENIED`                 | The actor lacks the route's permission, or holds it at a narrower scope       | `requiredPermission`                                                                                                                                                           |
| `MFA_ENROLMENT_REQUIRED`       | Grace period expired, or a privileged role without active MFA                 | `enrolUrl: "/api/v1/auth/mfa/enrol"`                                                                                                                                           |
| `MFA_STEP_UP_REQUIRED`         | No MFA assertion within 5 minutes on a step-up route                          | `maxAgeSeconds: 300`                                                                                                                                                           |
| `PASSWORD_CHANGE_REQUIRED`     | `app_user.password_must_change` is set, or a reset-issued credential was used | `changeToken` (opaque, 900 s, single-use, scoped to `POST /auth/password/forced-change` **only** — it authorises no other route, carries no session and is not a bearer token) |
| `REAUTH_REQUIRED`              | No password re-authentication within 300 s on a route marked **R** (§4.3)     | `maxAgeSeconds: 300`, `reauthUrl: "/api/v1/auth/reauth"`                                                                                                                       |
| `CSRF_TOKEN_INVALID`           | Header/cookie mismatch or bad HMAC                                            | —                                                                                                                                                                              |
| `CSRF_ORIGIN_REJECTED`         | `Origin` absent or not allowlisted                                            | —                                                                                                                                                                              |
| `CSRF_FETCH_METADATA_REJECTED` | `Sec-Fetch-*` combination forbidden on an unsafe method                       | —                                                                                                                                                                              |
| `SELF_APPROVAL_FORBIDDEN`      | The decision's subject employee is the actor                                  | —                                                                                                                                                                              |
| `ACCOUNT_DISABLED`             | `app_user.status = 'DISABLED'` or employee `EXITED`                           | —                                                                                                                                                                              |
| `READ_SENSITIVE_DENIED`        | Unmask attempted without `profile:read_sensitive:*`                           | `requiredPermission`                                                                                                                                                           |

**404 Not Found**

| Code        | Meaning                                                            |
| ----------- | ------------------------------------------------------------------ |
| `NOT_FOUND` | The object does not exist, or is outside scope. The only 404 code. |

**405 / 406 / 409 / 413 / 415 / 423 / 428 / 429**

| Code                           | Status | Meaning                                                                                                                                                                                                                                           | `details`                                                             |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `METHOD_NOT_ALLOWED`           | 405    |                                                                                                                                                                                                                                                   | `allow: string[]`                                                     |
| `NOT_ACCEPTABLE`               | 406    | `Accept` excludes JSON                                                                                                                                                                                                                            | —                                                                     |
| `STATE_TRANSITION_NOT_ALLOWED` | 409    | No `state_transition` row for (machine, from, to)                                                                                                                                                                                                 | `machine`, `fromState`, `toState`                                     |
| `GUARD_FAILED`                 | 409    | A transition guard predicate is false                                                                                                                                                                                                             | `guardKey`, plus that guard's allowlisted context keys                |
| `VERSION_CONFLICT`             | 409    | `If-Match` ≠ current `row_version`                                                                                                                                                                                                                | `currentVersion`                                                      |
| `DUPLICATE_RESOURCE`           | 409    | Unique constraint (duplicate file sha, duplicate period code, duplicate acknowledgement)                                                                                                                                                          | `constraint` (logical name, never the DB index name)                  |
| `SEGREGATION_REQUIRED`         | 409    | Maker-checker: the actor performed the preceding step                                                                                                                                                                                             | `requires` (e.g. `"a second Accounts approver"`)                      |
| `IDEMPOTENCY_IN_PROGRESS`      | 409    | Same key is executing                                                                                                                                                                                                                             | — (`Retry-After: 1`)                                                  |
| `CONFLICT`                     | 409    | Generic state collision not covered above                                                                                                                                                                                                         | —                                                                     |
| `DUAL_CONTROL_UNAVAILABLE`     | 409    | Fewer than two distinct, `ACTIVE`, MFA-enrolled users hold the persona a maker-checker step needs (`DATA-MODEL.md` §3.3). Raised by `POST /payroll/cycles`, `POST /hr/policies/:id/versions` and any `…/approve` whose checker pool is too small. | `persona`, `requiredDistinctUsers` (always 2), `currentDistinctUsers` |
| `PDF_NOT_READY`                | 409    | A visible artefact's file is still being generated (§11.2).                                                                                                                                                                                       | `reason: "PDF_NOT_READY"`, `entityType`                               |
| `PAYLOAD_TOO_LARGE`            | 413    | Body > 128 KiB, or a part > the context cap                                                                                                                                                                                                       | `maxBytes`                                                            |
| `UNSUPPORTED_MEDIA_TYPE`       | 415    |                                                                                                                                                                                                                                                   | `accepted: string[]`                                                  |
| `ACCOUNT_LOCKED`               | 423    | Progressive lockout (`SECURITY.md` §2.6)                                                                                                                                                                                                          | — (`Retry-After` set)                                                 |
| `PRECONDITION_REQUIRED`        | 428    | `If-Match` missing on a versioned write                                                                                                                                                                                                           | —                                                                     |
| `RATE_LIMITED`                 | 429    |                                                                                                                                                                                                                                                   | `retryAfterSeconds`                                                   |

**422 Unprocessable Content** — business rules. All render inline.

| Code                              | Raised by                                                               | `details`                                                     |
| --------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| `BUSINESS_RULE_VIOLATED`          | Fallback for a rule with no dedicated code                              | `rule`                                                        |
| `INSUFFICIENT_LEAVE_BALANCE`      | `leave.sufficient_balance`                                              | `availableDays`, `pendingDays`, `requestedDays`               |
| `LEAVE_DATES_OVERLAP`             | `leave.no_overlap`                                                      | `conflictingRequestReference`, `conflictStart`, `conflictEnd` |
| `NO_WORKING_DAYS_IN_RANGE`        | `working_days()` returns 0                                              | `startDate`, `endDate`                                        |
| `MIN_NOTICE_NOT_MET`              | `leave.min_notice`                                                      | `minNoticeDays`, `earliestStartDate`                          |
| `ATTACHMENT_REQUIRED`             | `leave.attachment_if_required`, `expense.receipt_if_required`           | `afterDays` \| `aboveAmountMinor`                             |
| `MANAGER_NOT_RESOLVED`            | `leave.manager_exists`, `expense.manager_exists`                        | —                                                             |
| `EXPENSE_LIMIT_EXCEEDED`          | `expense.within_hard_limits`                                            | `capAmountMinor`, `basis`, `lineNo`                           |
| `CLAIM_WINDOW_CLOSED`             | `expense.spend_within_claim_window`                                     | `windowDays`, `spendDate`                                     |
| `DECLARATION_WINDOW_CLOSED`       | `tax.declaration_window_open`                                           | `opensOn`, `closesOn`                                         |
| `PROOF_WINDOW_CLOSED`             | `tax.proof_window_open`                                                 | `opensOn`, `closesOn`                                         |
| `ENROLMENT_WINDOW_CLOSED`         | Benefit dependent add                                                   | `opensOn`, `closesOn`                                         |
| `PASSWORD_REJECTED`               | Length/breach check (`SECURITY.md` §2.2–2.3)                            | `reason: "TOO_SHORT" \| "BREACHED" \| "TOO_COMMON"`           |
| `PASSWORD_REUSED`                 | `password_history` hit                                                  | `historyDepth`                                                |
| `IDEMPOTENCY_KEY_REUSED`          | Same key, different `request_hash`                                      | —                                                             |
| `FILE_NOT_CLEAN`                  | Referenced `file_object.scan_status <> 'CLEAN'`                         | `fileId`, `scanStatus`                                        |
| `FILE_NOT_OWNED`                  | Referenced file was not uploaded by the actor for this purpose          | `fileId`                                                      |
| `CONTROL_TOTAL_MISMATCH`          | Declared vs parsed payroll batch total                                  | `declaredTotalMinor`, `parsedTotalMinor`                      |
| `ROW_VALIDATION_FAILED`           | Payroll/attendance bulk rows rejected                                   | `rejectedCount`, `reportUrl`                                  |
| `DAY_IDENTITY_VIOLATED`           | `ck_ar__day_identity` would fail                                        | `employeeId`, `expectedEligibleDays`, `suppliedSum`           |
| `WINDOW_NOT_OPEN`                 | Generic window guard                                                    | `opensOn`, `closesOn`                                         |
| `NOMINEE_SHARE_NOT_100`           | `PUT /me/nominees` — Σ `share_percent` ≠ 100 for a plan                 | `benefitPlanId`, `sum`                                        |
| `APPROVED_AMOUNT_EXCEEDS_CLAIM`   | A partial approval above `expense_claim.total_amount_minor`             | `claimTotalMinor`, `approvedAmountMinor`                      |
| `BODY_HASH_MISMATCH`              | `POST …/acknowledge` echoed a stale `bodySha256`                        | `currentVersionId`, `currentBodySha256`                       |
| `MASKED_VALUE_SUBMITTED`          | A write field matched a mask pattern (`•`)                              | `fieldKey`                                                    |
| `NOTE_REQUIRED`                   | A decision that requires a note supplied none                           | `outcome`                                                     |
| `MFA_REQUIRED_FOR_ROLE`           | Role grant to a target with no confirmed MFA credential                 | `roleId`, `persona`                                           |
| `SELF_SERVICE_FIELD_NOT_EDITABLE` | A change request named a field no persona may change through this route | `fieldKey`                                                    |

> **`BUSINESS_RULE_VIOLATED` is a fallback, not a bucket.** Where this table gives a dedicated
> code, the handler MUST emit that code; `BUSINESS_RULE_VIOLATED` with a `rule` string is
> permitted only for a rule that has no row here, and adding such a rule means adding a row
> here first (CI invariant 13, §17). The `rule` strings previously written inline in §13
> (`MASKED_VALUE_SUBMITTED`, `NOTE_REQUIRED`, `NOMINEE_SHARE_NOT_100`,
> `APPROVED_AMOUNT_EXCEEDS_CLAIM`, `BODY_HASH_MISMATCH`, `MFA_REQUIRED_FOR_ROLE`) are hereby
> promoted to first-class codes and are what the SPA branches on.

**5xx**

| Code                         | Status | Meaning                                                                                                                                                                                |
| ---------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INTERNAL_ERROR`             | 500    | Unhandled. Generic message only.                                                                                                                                                       |
| `INTEGRITY_ASSERTION_FAILED` | 500    | A server-side invariant failed (e.g. Σ payslip lines ≠ `gross_earnings_minor`). The response is a `500`, **never** a silently corrected number (`DATA-MODEL.md` §20.3). Pages on-call. |
| `UNAVAILABLE`                | 503    | Rate-limit store down on an auth route (fails closed), or shutting down. `Retry-After` set.                                                                                            |
| `DEPENDENCY_UNAVAILABLE`     | 503    | Object storage / KMS / mail provider unreachable on a path that cannot degrade.                                                                                                        |

> **Never leaked.** Database error text, Prisma error codes, constraint index names, file
> paths, stack traces, upstream provider responses, the existence of an out-of-scope id, or
> whether an email address is registered. A `pino` serialiser denylist plus the response
> schema enforcement in `SECURITY.md` §5.1 make this structural, not a review item.

---

## 3. Pagination

Two styles. **Every collection endpoint in §13 states which one it uses.** No endpoint
supports both.

### 3.1 Cursor pagination — for unbounded, time-ordered, append-heavy collections

Query: `?limit=<1..100, default 25>&cursor=<opaque>`
Optional per-endpoint filters are additive and are restated in the cursor.

```jsonc
{
  "data": [/* … */],
  "page": { "limit": 25, "nextCursor": "v1.eyJ…", "hasMore": true },
}
```

- The cursor is `base64url(JSON{ k: <keyset tuple>, f: <filter fingerprint>, s: <sub> })` with
  an appended `HMAC-SHA256` over that payload keyed by `CURSOR_KEY` **and the actor's `sub`**,
  so a cursor cannot be transplanted to another session (`SECURITY.md` §4.6). Tamper or
  cross-actor use ⇒ `400 INVALID_CURSOR`.
- Keyset, never `OFFSET`: the tuple is the endpoint's stated sort key plus `id` as the tiebreak.
- Changing any filter while paging invalidates the cursor (`f` mismatch ⇒ `400 INVALID_CURSOR`).
- `hasMore=false` ⇒ `nextCursor` is `null`. There is no `total` — computing one would be an
  unbounded scan, and no cursor-paginated surface in the prototype displays a total.

**Cursor-paginated endpoints:** notifications, announcements, help-desk tickets, ticket
comments, approval history, audit log, employee documents, expense claims, leave requests,
payroll input items, payroll validation results, attendance records, email outbox (admin),
HR document-request queue, HR ticket queue, manager expense claims, manager leave requests,
manager attendance slice records.

### 3.2 Page/limit pagination — for bounded, countable collections the UI counts

Query: `?page=<1..>&limit=<1..100, default 25>&sort=<allowlisted>`

```jsonc
{
  "data": [/* … */],
  "page": { "page": 1, "limit": 25, "total": 12, "totalPages": 1 },
}
```

- `total` is a real `COUNT(*)` over the **same scoped predicate** as `data`. The Directory
  header's "12 people shown" is this `total` and nothing else (`DATA-MODEL.md` §20.11).
- `page` beyond `totalPages` returns `200` with `data: []` — not a `404`.
- `sort` accepts only the values the endpoint lists; anything else ⇒ `400 UNSUPPORTED_SORT`.
- `sort` is `<field>` or `<field>:asc` / `<field>:desc`. A bare field uses the **default
  direction stated by the endpoint**; a direction the endpoint does not allow is
  `400 UNSUPPORTED_SORT` with `details.allowed` listing the exact accepted strings. Sorting is
  always stabilised by appending `id ASC`, so page boundaries cannot duplicate or drop a row.
- `total` is capped: a predicate matching more than 50 000 rows returns
  `total: 50000` and `totalIsExact: false`. Every page/limit surface in this contract is
  bounded well below that, so `totalIsExact` is `true` everywhere in practice; the field
  exists so a count can never become an unbounded scan.

**Page-paginated endpoints:** directory, payslips, policies, form 16, expense categories,
ticket categories, benefit plans, HR employee admin, payroll cycles, attendance periods,
letter templates, document requests, dependents, manager approvals, manager attendance
approvals, policy compliance. (Leave balances are **unpaged** — see §3.3.)

### 3.3 Unpaginated collections

A small, bounded reference set is returned whole, with **no** `page` object, as
`{"data": [...]}`. This is allowed **only** where the row count is bounded by configuration:
leave types, leave balances (one per active leave type), holidays for one calendar year,
payslip lines for one payslip, quarterly TDS (exactly 4), profile tabs, FAQ articles, nav
manifest, reporting line. Every such endpoint is marked **unpaged** in §13.

---

## 4. Authentication and session wire contract

### 4.1 The public routes

`POST /api/v1/auth/login` · `POST /api/v1/auth/refresh` ·
`POST /api/v1/auth/password-reset/request` · `POST /api/v1/auth/password-reset/confirm` ·
`POST /api/v1/auth/accept-invitation` · `POST /api/v1/auth/mfa/challenge` ·
`POST /api/v1/auth/password/forced-change` ·
`GET /api/v1/healthz` · `OPTIONS *` (CORS preflight, §1.1)

Eight routes, not five. `/auth/mfa/challenge`, `/auth/accept-invitation` and
`/auth/password/forced-change` are bearer-less by construction — the caller has no access
token yet — and each is authorised instead by a **single-use, short-lived, purpose-scoped
opaque token** (`mfaToken`, `invitationToken`, `changeToken`) that names exactly one route in
its stored record and is rejected on any other. Each declares
`config.public = { reason, boundToken }` so the boot assertion can prove the token binding
exists; a `config.public` route with no `boundToken` and no documented reason fails boot.

Every other route in this document declares `config.permission`. A route declaring neither
`permission` nor `public` fails the **boot-time** assertion in
`apps/api/src/plugins/authorize.ts` (`SECURITY.md` §4.6) — an unguarded route cannot ship.

### 4.2 Tokens on the wire

| Credential                   | Transport                                                                                                                                                        | Lifetime                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Access token (EdDSA JWT)     | `Authorization: Bearer` header. Held in an in-memory closure in the SPA, never `localStorage`.                                                                   | 600 s                                            |
| Refresh token (opaque, 32 B) | `__Host-wd_rt` cookie: `Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800`. Never in a response body.                                                    | 7 d idle / 14 d absolute family                  |
| CSRF token                   | `__Host-wd_csrf` cookie (readable) + `X-WD-CSRF` header.                                                                                                         | Rotated on login and on every `token_epoch` bump |
| MFA challenge token          | `mfaToken` in the login response body; single-use, bound to the login attempt.                                                                                   | 300 s                                            |
| Step-up assertion            | No separate token; `refresh_token.mfa_satisfied_at` + the access token's `mfa_at` claim.                                                                         | 300 s for step-up purposes                       |
| Re-auth assertion            | No separate token; the access token's `reauth_at` claim, set by `POST /auth/reauth` (§4.3)                                                                       | 300 s                                            |
| Invitation token             | `invitationToken` in the `USER_INVITE` email link; SHA-256-only at rest in `user_invitation.token_hash` with `token_fpr` for lookup; `attempt_count` capped at 5 | 7 d, single-use                                  |
| Forced-change token          | `changeToken` in the `403 PASSWORD_CHANGE_REQUIRED` body; single-use, scoped to `POST /auth/password/forced-change`                                              | 900 s                                            |

Access-token claims are exactly as `SECURITY.md` §3.1 (`iss`, `aud`, `sub`, `sid`, `jti`,
`iat`, `nbf`, `exp`, `ver`, `roles`, `emp`, `amr`, `auth_time`, `mfa_at`, `reauth_at`). `sid` is the
`refresh_token.family_id` — the session identity. `ver` carries `app_user.token_epoch`.
**No PII is in the token.** The SPA gets identity from `GET /api/v1/me`, never by decoding
the JWT.

### 4.3 Step-up MFA

Routes marked **Step-up: yes** require `now() - mfa_at ≤ 300 s`. Otherwise
`403 MFA_STEP_UP_REQUIRED`; the SPA opens the step-up dialog, calls
`POST /api/v1/auth/mfa/step-up`, receives a fresh access token, and retries the original
request.
**Two assertions, not one.** `mfa_at` proves a _second factor_ was presented recently;
`reauth_at` proves the _password_ was presented recently. A user enrolling their first MFA
credential has no `mfa_at` and never will until enrolment completes, so requiring `mfa_at`
there would be a deadlock. The primitive is therefore:

| Assertion   | Minted by                                                                                                                                                  | Claim       | Max age | Required by                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mfa_at`    | `POST /auth/mfa/challenge`, `POST /auth/mfa/step-up`                                                                                                       | `mfa_at`    | 300 s   | every step-up route in the list below **except** MFA enrolment                                                                                                                                  |
| `reauth_at` | `POST /auth/reauth` (body `{ password }`, returns a fresh access token, `RL user 5/5min`, wrong password ⇒ `401 INVALID_CREDENTIALS` + the lockout ladder) | `reauth_at` | 300 s   | `POST /auth/mfa/enrol`, `POST /auth/mfa/verify-enrolment`, `POST /auth/mfa/recovery-codes`, `DELETE /auth/mfa/credentials/:id`, and **in addition to** `mfa_at` on `POST /auth/password/change` |

A route marked **S** yes requires `mfa_at` unless its row above says otherwise; a route
marked **R** yes requires `reauth_at`. Missing/stale `reauth_at` ⇒ `403 REAUTH_REQUIRED`
(`details.maxAgeSeconds: 300`), a new code in §2.3's 403 block. Both claims are set to

`null` on every `token_epoch` bump, so a password change or role grant invalidates them.
**The step-up (`mfa_at`) set** (`SECURITY.md` §2.7):

bank-account and statutory change submission and HR verification · password change ·
MFA disable · any role grant or revoke · payroll approve, publish and correction approval ·
payslip publication revocation and correction · any export · admin user-status change ·
unmasking any statutory id or bank account · issuing a letter that includes salary details.

---

## 5. Authorization on the wire

Every endpoint row in §13 states `Permission` using the **exact seeded
`permission.code`** from `DATA-MODEL.md` §3.1 (format `<resource>:<action>[:<scope>]`,
scope ∈ `self` | `team` | `any`) and the ABAC scope it resolves to
(`SELF` | `DIRECT_REPORTS` | `REPORTING_CHAIN` | `DEPARTMENT` | `ORG`, `SECURITY.md` §4.2).
**One primary permission per route.** `config.permission` is a single seeded code — the one
the boot assertion and CI invariant 1 check. Where a handler needs a second capability it
declares `config.alsoRequires: string[]` (**all** must be held) or
`config.conditionalFields: { <permission>: <field path[]> }` (fields **omitted** from the DTO
when the permission is absent, never a `403`). Exactly two routes use each:

| Route                   | `permission`            | `alsoRequires` / `conditionalFields`                                                                                                                                                                             |
| ----------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me/tax/summary`   | `tax:quarter:read:self` | `alsoRequires: ['tax:declaration:read:self']`                                                                                                                                                                    |
| `GET /me/profile`       | `profile:read:self`     | `conditionalFields: { 'profile:read_sensitive:self': ['fields[].value for masked keys'] }` — without it those rows are returned with `value: null, isAvailable: false, isMasked: true` rather than being refused |
| `GET /directory/people` | `directory:read`        | `conditionalFields: { 'directory:read_contact': ['workPhone'] }`                                                                                                                                                 |
| `GET /hr/employees/:id` | `employee:read:any`     | `conditionalFields: { 'profile:read_sensitive:any': ['masked tab values','canUnmask'] }`                                                                                                                         |

**Persona binding is `DATA-MODEL.md` §3.3 and only §3.3.** This contract never invents a
grant. Three consequences that are load-bearing here and were previously stated wrongly:

1. **A Manager holds `approval:task:read:team`, never `approval:task:read:any`.** The `:any`
   scope would admit every manager's queue org-wide under the RLS shape of
   `DATA-MODEL.md` §1.8.3. `approval:task:read:any` is an **HR-only** code for the escalation
   and audit surfaces. Every `/manager/**` route in §13 therefore declares a `:team` code and
   resolves `assignee_employee_id = :me` in the query.
2. **A Manager holds no `:read:any` code of any kind and no `profile:read_sensitive:*`.**
   A manager surface never returns an unmasked statutory id, a salary figure, or a person
   outside `employee_reporting_closure`.
3. **HR holds `payroll:cycle:read` and nothing else in `payroll:*`; Accounts holds no
   `attendance:capture|submit|approve:*` and no `employee:*` or `role:*`.** Any route that
   would need HR to read an amount, or Accounts to author attendance, is not in this
   contract and must not be added without changing §3.3 first.

Enforcement order, for every request (`SECURITY.md` §4.6):

```
verify JWT (alg/iss/aud/exp/kid) → load session family by sid (live, not revoked)
 → ver == app_user.token_epoch (else 401 TOKEN_STALE)
 → actor = { userId, employeeId, personas[], scopes[], mfaAt, authTime }
 → required = route.config.permission        (absent at boot ⇒ build fails)
 → grants  = union over held personas        (§4.7 of SECURITY.md)
 → alsoRequires ⊆ grants                     (else 403 AUTHZ_DENIED)
 → none ⇒ 403 AUTHZ_DENIED (audited)
 → scope  = widest grant FOR THIS PERMISSION
 → where  = authzWhere(actor, required, scope)   ← compiled into the query
 → separation.ts subtracts § self-dealing and ‡ maker-checker
 → guards(state_transition.guard_key) on mutations
 → handler
```

Three invariants the contract depends on:

1. **Scope is compiled into the query, never checked after the fetch.** A `findFirst` with the
   scope predicate returning nothing ⇒ `404 NOT_FOUND`.
2. **A manager is never inside their own approval scope** (`REPORTING_CHAIN` requires
   `depth ≥ 1`; `approval_task` carries `ck_at__not_self`).
3. **Accounts never receives non-payroll PII** — enforced at the permission layer, the DTO
4. **Cosmetic gating is never a control.** `GET /me` returns `permissions[]` so the SPA can
   hide controls; every route re-resolves the grant server-side. A test in CI (§17 invariant 16) calls every route with every persona that lacks its permission and asserts `403`/`404`.
5. **Scope widening is impossible through a body field.** No request body anywhere in this
   contract accepts an `employeeId`, `organizationId`, `roleId` or `scope` that widens the
   actor's own reach; where a back-office route names another employee, that id is a **path**
   parameter resolved through `authzWhere`, so an out-of-scope id is `404`, not `403`.
   allowlist layer and the `payroll_employee_v` view layer (`SECURITY.md` §4.5).

---

## 6. Guards on the wire

A mutation that drives a state machine runs `assertTransition(machine, from, to, actor)`
against the seeded `state_transition` table, then every `guard_key` on that row
(`DATA-MODEL.md` §19.3). Failures map to:

| Situation                                               | Status | Code                                  |
| ------------------------------------------------------- | ------ | ------------------------------------- |
| No `state_transition` row for (machine, from, to)       | `409`  | `STATE_TRANSITION_NOT_ALLOWED`        |
| Row exists, `required_permission_code` not held         | `403`  | `AUTHZ_DENIED`                        |
| Row exists, a guard predicate is false                  | `409`  | `GUARD_FAILED` (+ `details.guardKey`) |
| Guard is a _business_ rule the user can fix in the form | `422`  | The dedicated code from §2.3          |

The `409`/`422` split is by audience: `409 GUARD_FAILED` means "the workflow is not at the
right step" (a state problem, usually someone else's action is outstanding);
`422` means "your input breaks a rule you can change". Guards mapped to `422`:
`leave.sufficient_balance`, `leave.no_overlap`, `leave.min_notice`,
`leave.attachment_if_required`, `leave.manager_exists`, `expense.receipt_if_required`,
`expense.within_hard_limits`, `expense.spend_within_claim_window`, `expense.manager_exists`,
`tax.declaration_window_open`, `tax.proof_window_open`, `tax.all_items_have_proof`.
**Every other guard maps to `409 GUARD_FAILED`.**
Two further rules close the gap this split leaves open:

- A guard listed as `422` on **create/update** is re-evaluated at **submit** and at
  **decision** time; failing it later is `409 GUARD_FAILED`, because by then it is someone
  else's state that moved, not the author's input.
- `GUARD_FAILED.details` is an allowlist **per guard key**, seeded alongside the guard in
  `state_transition`. A guard whose allowlist is undefined returns `details: { guardKey }`
  and nothing else. No guard ever puts a money value, an employee name outside the actor's
  scope, or a raw row into `details`.

`GUARD_FAILED.details` carries the guard key plus an allowlisted context so the UI can state
the real reason — e.g. for `attendance.payroll_inputs_locked`:
`{"guardKey":"attendance.payroll_inputs_locked","periodLabel":"August 2026","cycleStatus":"INPUTS_OPEN"}`
renders _"Accounts has not locked payroll inputs for August 2026 yet."_

---

## 7. Audit on the wire

Every mutation, every `READ_SENSITIVE` and every `DOWNLOAD` writes an `audit_event` **in the
same transaction** as the effect (`DATA-MODEL.md` §17.1). The API never returns audit fields
to non-audit callers, but two response conventions exist so the UI can be honest:

- A successful state change returns the resource with its **new** `status`, `statusLabel`,
  `statusTone` and `row_version` — the SPA never optimistically guesses a new status.
- Responses to actions that recorded an acknowledgement, decision or acknowledgement-like
  fact include the persisted timestamp (`acknowledgedAt`, `decidedAt`, `submittedAt`), so the
  toast shows the stored value, not `Date.now()`.

---

## 8. Idempotency

### 8.1 Mechanism

`Idempotency-Key` + `ess_ops.idempotency_key` (`DATA-MODEL.md` §17.5), unique on
`(organization_id, app_user_id, key, route)`.

```
1. Compute request_hash = SHA-256(canonical(method, routerPath, sorted body, actor.userId))
2. INSERT … ON CONFLICT DO NOTHING with locked_at = now()
   2a. Inserted        → execute the handler in a transaction; persist
                         (response_status, response_body); return it.
   2b. Conflict, completed_at IS NOT NULL, request_hash equal
                       → return the stored status + body verbatim,
                         with `Idempotency-Replayed: true`. No side effect re-runs.
   2c. Conflict, completed_at IS NULL (in flight, locked_at < 60 s ago)
                       → 409 IDEMPOTENCY_IN_PROGRESS, Retry-After: 1
   2c'. Conflict, completed_at IS NULL, locked_at >= 60 s ago (the executing process died)
                       → the row is *taken over*: UPDATE … SET locked_at = now(),
                         takeover_count = takeover_count + 1
                         WHERE id = $1 AND completed_at IS NULL AND locked_at = $prev
                         (a zero-row update means another worker won the race
                          → 409 IDEMPOTENCY_IN_PROGRESS). The handler then re-executes.
                         Because every handler body is a single transaction, a takeover
                         cannot double-apply a committed effect; a handler whose transaction
                         had already committed before the crash is detected by its own
                         uniqueness constraint and replays as 2b.
   2d. Conflict, request_hash differs
                       → 422 IDEMPOTENCY_KEY_REUSED
3. Records expire after 24 h (`expires_at`); a key reused after expiry executes afresh.
```

A handler that fails with a `4xx` **still stores** its response, so a retried
client-side error replays identically rather than producing a second partial attempt. A
`5xx` is **not** stored — the row's lock is released so a retry can genuinely re-run.

**Scoping on public routes.** `ess_ops.idempotency_key` is unique on
`(organization_id, app_user_id, key, route)`. On the three public routes that take a key
(`/auth/password-reset/confirm`, `/auth/accept-invitation`, `/auth/password/forced-change`)
there is no authenticated actor at the time of the insert, so `app_user_id` is the **subject
the bound token resolves to**, which is known before the handler runs and is exactly the
identity the operation mutates. `organization_id` comes from the same record. A key is never
scoped to an IP or left null — a null would let two users collide on one key.

**Key minting.** The SPA mints a fresh `Idempotency-Key` (`crypto.randomUUID()`) on every
user-initiated submit, **not** once per form mount, because §8.1 step 2d deliberately turns a
changed body under a reused key into `422 IDEMPOTENCY_KEY_REUSED`. This is enforced by an
ESLint rule on the mutation hooks (`apps/web/src/lib/mutations.ts`).

### 8.2 Endpoints that REQUIRE `Idempotency-Key`

Anything that creates a durable business record, moves a state machine, mints money-adjacent
data, sends an email, or issues a credential:

| Group         | Endpoints                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth          | `POST /auth/mfa/enrol`, `/auth/mfa/verify-enrolment`, `/auth/mfa/recovery-codes`, `/auth/password/change`, `/auth/password-reset/confirm`, `/auth/accept-invitation`, `/auth/password/forced-change`                                                                                                                                                                                                                                            |
| Leave         | `POST /me/leave-requests`, `…/:id/withdraw`, `…/:id/submit`, `POST /manager/leave-requests/:id/{approve,reject}`, `POST /hr/leave-requests/:id/cancel`                                                                                                                                                                                                                                                                                          |
| Attendance    | `POST /hr/attendance/periods/:id/records:bulk`, `…/:id/submit`, `POST /hr/attendance/periods/:id/reopen`, `POST /manager/attendance/approvals/:id/{approve,return}`, `POST /hr/attendance/approvals/:id/escalate`                                                                                                                                                                                                                               |
| Payroll       | `POST /payroll/cycles`, `…/:id/input-batches`, `…/input-batches/:id/commit`, `…/:id/lock-inputs`, `…/:id/validate`, `…/:id/calculate`, `…/:id/approve`, `…/:id/publish`, `…/:id/close`, `…/:id/cancel`, `…/:id/reopen-inputs`, `…/:id/discard-run`, `…/:id/scope/:employeeId/defer`, `…/:id/validations/:validationId/resolve`, `POST /payroll/corrections`, `…/:correctionId/{approve,reject}`, `POST /payroll/publications/:payslipId/revoke` |
| Payslips      | `POST /me/payslips/:id/email`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Expenses      | `POST /me/expense-claims`, `…/:id/submit`, `…/:id/withdraw`, `POST /manager/expense-claims/:id/decide`, `POST /accounts/expense-claims/:id/decide`, `POST /accounts/reimbursement-batches`, `POST /accounts/reimbursement-batches/:id/add`, `…/:id/lock`, `…/:id/send-to-payroll`                                                                                                                                                               |
| Documents     | `POST /me/document-requests`, `POST /hr/document-requests/:id/{claim,start,issue,reject}`, `POST /hr/employees/:employeeId/documents`                                                                                                                                                                                                                                                                                                           |
| Policies      | `POST /me/policy-versions/:versionId/acknowledge`, `POST /hr/policies/:id/versions`, `POST /hr/policy-versions/:id/{submit-review,return,reassign,publish,withdraw}`, `POST /hr/policy-assignments/:id/waive`                                                                                                                                                                                                                                   |
| Announcements | `POST /hr/announcements`, `…/:id/publish`, `…/:id/{pin,unpin,archive}`                                                                                                                                                                                                                                                                                                                                                                          |
| Help desk     | `POST /me/tickets`, `…/:id/comments`, `…/:id/close`, `…/:id/reopen`, `POST /hr/tickets/:id/{assign,start,request-info,comments,resolve,retry-notification}`, `POST /admin/email-outbox/:id/retry`                                                                                                                                                                                                                                               |
| Approvals     | `POST /manager/approvals/:id/decide` (the polymorphic queue action)                                                                                                                                                                                                                                                                                                                                                                             |
| Tax           | `POST /me/tax/declaration/submit`, `POST /accounts/form16/:id/issue`, `POST /accounts/tds-quarters/:id/file`, `POST /accounts/tax/declarations/:id/verify`                                                                                                                                                                                                                                                                                      |
| Benefits      | `POST /me/dependents`, `POST /me/benefits/:planYearId/enrol`                                                                                                                                                                                                                                                                                                                                                                                    |
| Profile       | `POST /me/profile-change-requests`, `POST /me/emergency-contacts`, `POST /hr/profile-change-requests/:id/{claim,approve,reject}`                                                                                                                                                                                                                                                                                                                |
| Files         | `POST /files`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Admin         | `POST /hr/employees`, `POST /hr/employees/:id/{invite,resend-invitation,activate,suspend,reinstate,resign,offboard,deactivate}`, `POST /admin/users/:id/roles`, `DELETE /admin/users/:id/roles/:roleId`, `POST /admin/users/:id/{revoke-sessions,reset-mfa,disable}`, `POST /admin/role-grant-requests/:id/{approve,reject}`, `POST /admin/audit/export`                                                                                        |

> **This table is normative and complete.** §13.19 binds every `state_transition` to exactly
> one endpoint; every one of those endpoints that is a `POST` appears above. CI invariant 8
> (§17) walks the route table and fails the build on any `POST` that moves a state machine,
> sends an email, mints a credential or creates a durable record and does **not** declare
> `config.idempotent: true` — so this list cannot silently fall behind §13.19.

### 8.3 Endpoints that do NOT take `Idempotency-Key`

All `GET`/`HEAD`; `PATCH` guarded by `If-Match` (already exactly-once via the version check);
`DELETE` of a single addressable resource (naturally idempotent); `POST /auth/login`,
`/auth/refresh`, `/auth/logout`, `/auth/logout-all`, `/auth/mfa/step-up`,
`/auth/password-reset/request` (each already single-use or state-derived); `POST /me/announcements/:id/read`
and `POST /me/notifications/read` (upserts, naturally idempotent).

Sending `Idempotency-Key` to one of these is ignored, not an error.

---

## 9. Optimistic concurrency

Resources whose table carries `row_version` (`leave_request`, `expense_claim`,
`attendance_period`, `attendance_record`, `attendance_approval`, `payroll_cycle`,
`payroll_input_batch`, `approval_task`, `helpdesk_ticket`, `document_request`,
`announcement`, `benefit_enrolment`, `employee_tax_declaration`, `reimbursement_batch`)
expose it two ways:

- `ETag: "<row_version>"` response header on any single-resource response.
- `version: <int>` field inside the resource body (so a list can carry it without per-row headers).

`PATCH`/`PUT`/state-changing `POST` on these resources:

| Condition            | Response                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `If-Match` absent    | `428 PRECONDITION_REQUIRED`                                                                                                                     |
| `If-Match` ≠ current | `409 VERSION_CONFLICT` with `details.currentVersion`; the SPA refetches and shows the moved-on state                                            |
| Match                | Executes; `UPDATE … SET row_version = row_version + 1 WHERE id = $1 AND row_version = $2`; a zero-row update is itself a `409 VERSION_CONFLICT` |

**Three stated exceptions to `If-Match`**, each because the request addresses a _set_, not a
row, so there is no single version to match:

| Route                                          | Instead of `If-Match`                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /hr/attendance/periods/:id/records:bulk` | `If-Match` on the **period** (`attendance_period.row_version`) plus per-row `DAY_IDENTITY` validation; rows whose `attendance_record.row_version` changed since the file was parsed are rejected into `rejections[]` with `reason: "ROW_CHANGED_SINCE_UPLOAD"`, never silently overwritten. |
| `POST /accounts/reimbursement-batches/:id/add` | `If-Match` on the **batch**; each claim must still be `FINANCE_APPROVED` at commit time or the whole call is `409 GUARD_FAILED`.                                                                                                                                                            |
| `POST /me/notifications/read`                  | None — it is an idempotent upsert over a caller-supplied id list and carries no versioned resource.                                                                                                                                                                                         |

CI invariant 9 (§17) is written against this list: a versioned-table route that is not one of
these three and does not declare `config.requireIfMatch: true` fails the build.

Immutable resources (`payslip`, `payslip_line`, `policy_acknowledgement`,
`leave_balance_ledger`, `approval_decision`, `audit_event`, `attendance_submission`) have no
`row_version`, expose no `PATCH`, and reject `PUT`/`DELETE` with `405 METHOD_NOT_ALLOWED`.

---

## 10. File upload contract

### 10.1 Decision: direct-to-API multipart. Not pre-signed PUT.

**Chosen: `POST /api/v1/files` — `multipart/form-data` streamed through the API.**

Justification, specific to this system rather than generic:

1. **Every mandated validation is pre-commit and server-side.** `SECURITY.md` §5.3 requires,
   in order: route authorization _before the stream is consumed_, streaming size cap,
   extension allowlist, declared-MIME allowlist, **magic-byte sniffing that must agree with
   both**, PDF active-content inspection (`/JavaScript`, `/OpenAction`, `/EmbeddedFile`, …),
   image re-encode with full EXIF/GPS strip, HEIC transcode, CSV/XLSX parsing in a worker
   with row/column caps and no formula evaluation, and a ClamAV INSTREAM scan. A pre-signed
   `PUT` puts the attacker's bytes in the bucket **before any of that runs**. The bucket then
   holds unvalidated content and the pipeline becomes eventually-consistent: an S3 event, a
   scanner worker, a quarantine bucket, a promotion step, and a window during which a
   `file_object` row may exist for bytes nobody has inspected.
2. **It removes a trust boundary rather than adding one.** Pre-signed upload requires the
   browser to talk directly to object storage, which means a storage CORS policy, a second
   origin in the SPA's CSP `connect-src`, and a credential (the signature) that is valid
   without the API in the loop. `SECURITY.md` §5.3.13 requires the bucket to have public
   access blocked and no wildcard CORS; direct-to-API keeps that literally true.
3. **The volume does not justify the cost.** Caps are 25 MiB (payroll CSV/XLSX) and 10 MiB
   (bills, ticket attachments), at ≤ 20 uploads/user/hour and ≤ 200 MiB/user/day
   (`SECURITY.md` §9.1). Fastify's streaming multipart never buffers a whole body; the API
   container is not the bottleneck at this scale. The operational simplicity of one code path
   is worth more than saved egress.
4. **The payroll CSV must be parsed synchronously enough to return a row-level report.**
   The Accounts upload screen needs `row_count_valid` / `row_count_rejected` and the per-row
   `rejection_reason` list. With direct-to-API the upload response can already carry the parse
   outcome (or a `202` + batch id when the file is large); with pre-signed PUT the client must
   poll a second endpoint for a result the API could have returned.
5. **Auditability.** `file_object.uploaded_by_user_id`, `sha256` over the _stored_ bytes,
   and the `audit_event` are written in one transaction with the row. With pre-signed PUT the
   hash the client claims and the bytes that land can differ until a worker reconciles them.

> **Downloads are the mirror image and use pre-signed GET** (§11): by then the bytes are
> validated, immutable and possibly large (a Form 16 PDF), and streaming them through the API
> would waste container capacity for no security gain. Upload = validate before storing;
> download = authorize then redirect.

### 10.2 `POST /api/v1/files`

**Permission** depends on `purpose` (table below) · **Idempotency** Required ·
**Step-up** no · **Rate limit** `user`: 20/h and 200 MiB/24 h · **Content-Type**
`multipart/form-data`

Parts:

| Part        | Type                      | Constraints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `purpose`   | text field                | `ess_file_purpose` value, restricted to the uploadable subset: `EXPENSE_BILL`, `TICKET_ATTACHMENT`, `PROFILE_PROOF`, `PAYROLL_INPUT_UPLOAD`, `ATTENDANCE_UPLOAD`, `POLICY_PDF`, `BENEFIT_DOCUMENT`, `EMPLOYEE_DOCUMENT`. `PAYSLIP_PDF`, `FORM16_PDF`, `LETTER_PDF` and `ORG_ASSET` are **system-generated only** and rejected with `403 AUTHZ_DENIED`.                                                                                                                                                                                                         |
| `file`      | file part                 | Exactly one. Caps per purpose below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `contextId` | text field, optional uuid | The claim / ticket / cycle / employee the file is destined for. It is **resolved through `authzWhere` for the purpose's permission before a byte is read** — an id the actor cannot reach is `404 NOT_FOUND`, so `contextId` can never widen scope or set `owner_employee_id` to a stranger. `owner_employee_id` is then taken from the resolved entity, never from the request. Required for `EMPLOYEE_DOCUMENT` and `PAYROLL_INPUT_UPLOAD`; optional elsewhere, in which case `owner_employee_id = actor.employeeId`. The file is not attached by this call. |

Per-purpose gate (mirrors `SECURITY.md` §5.3):

| `purpose`              | Permission                  | Allowed sniffed types | Max size |
| ---------------------- | --------------------------- | --------------------- | -------- |
| `EXPENSE_BILL`         | `expense:claim:create:self` | pdf, jpeg, png, heic  | 10 MiB   |
| `TICKET_ATTACHMENT`    | `ticket:create:self`        | pdf, jpeg, png        | 10 MiB   |
| `PROFILE_PROOF`        | `profile:update:self`       | pdf, jpeg, png        | 10 MiB   |
| `PAYROLL_INPUT_UPLOAD` | `payroll:input:upload`      | text/csv, xlsx        | 25 MiB   |
| `ATTENDANCE_UPLOAD`    | `attendance:capture`        | text/csv, xlsx        | 25 MiB   |
| `POLICY_PDF`           | `policy:author`             | pdf                   | 20 MiB   |
| `BENEFIT_DOCUMENT`     | `benefit:manage`            | pdf                   | 20 MiB   |
| `EMPLOYEE_DOCUMENT`    | `document:upload:any`       | pdf                   | 20 MiB   |

**`201 Created`** — `Location: /api/v1/files/{id}`

```jsonc
{
  "id": "…uuid",
  "purpose": "EXPENSE_BILL",
  "originalFilename": "uber-receipt.pdf", // file_object.original_filename (sanitised)
  "mimeType": "application/pdf", // file_object.mime_type — the SNIFFED type
  "sizeBytes": 184213, // file_object.size_bytes (of the STORED bytes)
  "sha256": "9f2c…", // hex of file_object.sha256
  "scanStatus": "PENDING", // file_object.scan_status
  "isUsable": false, // = scan_status == 'CLEAN'
  "uploadedAt": "2026-09-29T10:14:02.117Z",
}
```

**`202 Accepted`** with the same body when the ClamAV verdict is not yet available. The SPA
renders a "Scanning…" chip and polls `GET /api/v1/files/:id` (cheap, metadata only). A file
is **never** attachable, servable or emailable while `scanStatus <> 'CLEAN'`
(`DATA-MODEL.md` §17.2).

Errors: `400 VALIDATION_FAILED` (bad `purpose`, no file part, two file parts) ·
`403 AUTHZ_DENIED` · `413 PAYLOAD_TOO_LARGE` (`details.maxBytes`) ·
`415 UNSUPPORTED_MEDIA_TYPE` (`details.accepted`) · `422 BUSINESS_RULE_VIOLATED` with
`details.rule = "TYPE_MISMATCH" | "ACTIVE_CONTENT_IN_PDF" | "ENCRYPTED_PDF" | "SVG_REJECTED" | "TOO_MANY_PAGES" | "TOO_MANY_ROWS"` ·
`429 RATE_LIMITED` · `503 DEPENDENCY_UNAVAILABLE` (object storage or scanner hard-down).

### 10.3 `GET /api/v1/files/:id`

**Permission** `file:download:self` (owner) or `file:download:any` · **unpaged metadata read**

Returns the object above. Used for scan-status polling. `404 NOT_FOUND` when the file is
outside scope — the owning entity's scope, not the file's own id (an expense bill is
reachable only by someone who may read that claim, `SECURITY.md` §5.3.12).

### 10.4 Attaching a file

Files are attached by passing the id to the owning resource's endpoint
(`attachmentFileIds` on an expense claim, `attachmentFileId` on a leave request, etc.).
On attach the server re-checks: the file exists, `scan_status = 'CLEAN'`
(else `422 FILE_NOT_CLEAN`), `uploaded_by_user_id = actor.userId` **and** `purpose` matches

the destination (else `422 FILE_NOT_OWNED`), and — for a purpose whose `owner_employee_id`
differs from the uploader (`EMPLOYEE_DOCUMENT`, `POLICY_PDF`, `BENEFIT_DOCUMENT`) — that the
actor still holds the uploading permission **and** the destination entity is the one named by
`contextId` at upload time. A file may be attached to **exactly one** entity: the second
attach is `409 DUPLICATE_RESOURCE` (`constraint="file_object_single_attachment"`), which
stops a bill being re-pointed at another employee's claim after approval.
An unattached file older than 24 h is deleted by
the `file-retention-purge` job.

---

## 11. Download contract — signed URLs

### 11.1 The redirect endpoint

```
GET /api/v1/{resource-path}/download
```

There is no generic "download any file id" route. Each downloadable artefact has its own

endpoint that authorizes the **owning entity** first. `GET /api/v1/files/:id` (§10.3) is
metadata only and returns no bytes and no URL; **any response field that carries a link to a
file names one of the routes below**, never `/files/:id`.

| Endpoint                                                | Authorizes                                                                      | Audits                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /me/payslips/:id/download`                         | the `payslip_publication` visibility gate                                       | `DOWNLOAD` + `payslip_publication.download_count += 1`, `first_downloaded_at` |
| `GET /me/tax/form16/:id/download`                       | `form16_document.employee_id = :me AND status IN ('ISSUED','REVISED')`          | `DOWNLOAD`                                                                    |
| `GET /me/documents/:id/download`                        | `employee_document` visibility + `archived_at IS NULL`                          | `DOWNLOAD` + `download_count += 1`                                            |
| `GET /me/document-requests/:id/download`                | `document_request.employee_document_id IS NOT NULL`                             | `DOWNLOAD`                                                                    |
| `GET /me/policies/:versionId/download`                  | a live `policy_assignment` **or** `policy:read`                                 | `DOWNLOAD`                                                                    |
| `GET /me/benefits/enrolments/:id/ecard`                 | `benefit_enrolment.employee_id = :me`                                           | `DOWNLOAD`                                                                    |
| `GET /me/expense-claims/:id/attachments/:attachmentId`  | claim scope                                                                     | `DOWNLOAD`                                                                    |
| `GET /me/tickets/:id/attachments/:attachmentId`         | ticket scope                                                                    | `DOWNLOAD`                                                                    |
| `GET /payroll/cycles/:id/input-batches/:batchId/source` | `payroll:input:read`                                                            | `DOWNLOAD` (`READ_SENSITIVE`)                                                 |
| `GET /hr/employees/:id/documents/:docId/download`       | `document:read:any`                                                             | `DOWNLOAD` (`READ_SENSITIVE`)                                                 |
| `GET /admin/audit/export`                               | `audit:export`                                                                  | `EXPORT`                                                                      |
| `GET /admin/exports/:id/download`                       | `audit:export` (or the export's own permission)                                 | `EXPORT`                                                                      |
| `GET /org/logo`                                         | public-to-authenticated (`org:read`); serves `organization.logo_file_object_id` | none (not sensitive)                                                          |
| `GET /me/benefits/plans/:planId/document`               | `benefit:read:self` + a live enrolment                                          | `DOWNLOAD`                                                                    |
| `GET /me/announcements/:id/attachment`                  | announcement audience match                                                     | `DOWNLOAD`                                                                    |

### 11.2 Behaviour

Default (`?mode=redirect`, or no query):

```http
HTTP/1.1 302 Found
Location: https://<bucket>.s3.<region>.amazonaws.com/…?X-Amz-Expires=120&X-Amz-Signature=…
Cache-Control: no-store
```

`?mode=json` (used by the SPA so it can show a spinner and handle errors as JSON rather than
following a redirect blindly):

```jsonc
{
  "url": "https://…", // single-object, 120 s, method GET only
  "expiresAt": "2026-09-29T10:16:02Z",
  "filename": "Payslip_Aug-2026.pdf", // from the persisted file_name / composed label
  "mimeType": "application/pdf",
  "sizeBytes": 184213,
}
```

Contract for the signed URL (`SECURITY.md` §5.3.12):

- **120 seconds**, single object, `GET` only, no wildcard.
- Response-header overrides baked into the signature:
  `Content-Disposition: attachment; filename="…"; filename*=UTF-8''…` — **never `inline`**;
  `Content-Type:` the sniffed type; `X-Content-Type-Options: nosniff`;
  `Content-Security-Policy: default-src 'none'; sandbox`; `Cache-Control: private, no-store`.
- The filename is sanitised (CR, LF, `"`, `\` stripped; RFC 5987 encoding for `filename*`)
  and is derived from persisted values (`form16_document.file_name`,
  `payslip.reference_no` + `period_label`), never from user input.
- A URL is minted **only after** the authorization check and only for a file with
  `scan_status = 'CLEAN'` and `deleted_at IS NULL`.
- Every mint writes the `audit_event` listed above **before** the redirect is sent.
- `?mode=json` and `?mode=redirect` are the only accepted values; anything else is
  `400 VALIDATION_FAILED`.
- A signed URL is minted for **one** object; there is no batch mint and no directory
  listing signature. The 120 s TTL is a constant, not a query parameter.

Errors: `403 AUTHZ_DENIED` · `404 NOT_FOUND` (no such artefact, or out of scope, or the
underlying `file_object_id` is `NULL` — e.g. a payslip whose PDF has not been generated yet)
· `409 CONFLICT` with `details.reason = "PDF_NOT_READY"` when the artefact exists and is
visible but its file is still being generated (the SPA disables the button with "PDF is
being generated") · `429 RATE_LIMITED` (120 signed URLs/user/h) ·
`503 DEPENDENCY_UNAVAILABLE`.

---

## 12. Shared response objects (DTO catalogue)

Defined once, referenced by name in §13. **Every field is annotated with its source.**
A field marked _(computed)_ states its formula. A field not listed does not exist on the wire.

### 12.1 `ChipDto` — status chips

```jsonc
{ "value": "APPROVED", "label": "Approved", "tone": "GREEN" }
```

`value` = the raw enum. `label` = `ui_copy` for `status.<machine>.<value>`.
`tone` ∈ `GREEN|AMBER|RED|BLUE|GRAY` per `DESIGN-SYSTEM.md` §1 and the per-machine mappings
in `DATA-MODEL.md` (§13.3 expenses, §14.3 document requests, §16.4 tickets, §15.4 policies).
The SPA never derives a chip from a status.

### 12.2 `MoneyDto`

```jsonc
{ "amountMinor": 8600000, "currency": "INR" }
```

Integer paise. A **nullable** money field is `null`, not `{"amountMinor": 0}`.

### 12.3 `MetricDto` — the prototype's `k` / `v` / `sub` tile

```jsonc
{
  "key": "GROSS_EARNED",
  "label": "Gross earned", // ui_copy
  "value": { "amountMinor": 1104000000, "currency": "INR" }, // null ⇒ render "—"
  "subLabel": "Apr – Aug 2026", // composed from persisted labels
  "isAvailable": true, // = value !== null
}
```

### 12.4 `PersonRefDto` — directory-safe person reference

```jsonc
{
  "employeeId": "…uuid",
  "fullName": "Priya Raghavan", // employee.full_name (generated column)
  "initials": "PR", // employee.initials (generated column)
  "accentColourHex": "#1B365D", // department.accent_colour_hex ?? organization.default_accent_colour_hex
  "title": "Senior Software Engineer", // designation.title via employment_as_of(id, today)
  "department": "Platform Engineering", // department.name
  "location": "Bengaluru", // location.city
}
```

Contains **no** contact details. Used on approval cards, team lists, reporting lines.

### 12.5 `MaskedValueDto`

```jsonc
{ "masked": "AXYPR••••K", "isMasked": true, "canUnmask": false }
```

`masked` comes from the persisted `_mask` column — a masked read performs **no decryption**
(`SECURITY.md` §7.5). `canUnmask` = the actor holds the unmasking permission; it does **not**
mean the value is in this payload. Unmasking is a separate step-up endpoint.
A masked field is **never** accepted as write input: a request value matching
`/[•\u2022]/` on any field whose column has a `_mask` sibling is
`422 MASKED_VALUE_SUBMITTED` with `details.fieldKey`.

### 12.6 `PageDto`

Either `{ "limit": 25, "nextCursor": "v1.…"|null, "hasMore": false }`
or `{ "page": 1, "limit": 25, "total": 12, "totalPages": 1 }` (§3).

### 12.7 `EmptyStateDto`

`{ "code": "…", "title": "…", "message": "…", "params": { … } }` (§1.6).

### 12.8 `LeaveRequestDto`

| Field                        | Source                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | `leave_request.id`                                                                                                                                                                                         |
| `reference`                  | `leave_request.reference_no`                                                                                                                                                                               |
| `leaveType`                  | `{ id, code, name }` from `leave_type`                                                                                                                                                                     |
| `startDate`, `endDate`       | `leave_request.start_date` / `.end_date`                                                                                                                                                                   |
| `startPortion`, `endPortion` | `ess_leave_day_portion`                                                                                                                                                                                    |
| `totalDays`                  | `leave_request.total_days` — **trigger-maintained** as `SUM(day_fraction) FILTER (counts_toward_balance)`; never client-supplied                                                                           |
| `rangeLabel`                 | _(computed)_ `start = end ? fmt(start) : fmt(start) + ' – ' + fmt(end)` in `organization.locale`/`timezone`                                                                                                |
| `daysLabel`                  | _(computed)_ `totalDays + (totalDays > 1 ? ' days' : ' day')`                                                                                                                                              |
| `reason`                     | `leave_request.reason` (nullable)                                                                                                                                                                          |
| `status`                     | `ChipDto` over `ess_leave_request_status`                                                                                                                                                                  |
| `submittedAt`, `decidedAt`   | timestamps                                                                                                                                                                                                 |
| `decisionNote`               | `leave_request.decision_note`                                                                                                                                                                              |
| `approver`                   | `PersonRefDto` from `leave_request.approver_employee_id`; omitted when unresolved                                                                                                                          |
| `balanceAfterDays`           | `leave_request.balance_after_days` (nullable)                                                                                                                                                              |
| `attachment`                 | `{ fileId, filename, scanStatus }` from `attachment_file_object_id`; omitted when null                                                                                                                     |
| `canWithdraw`                | _(computed)_ `status IN ('PENDING_APPROVAL','APPROVED') AND start_date > CURRENT_DATE AND attendance_record_id IS NULL` — the exact guards `leave.starts_in_future` + `leave.not_yet_locked_by_attendance` |
| `version`                    | `leave_request.row_version`                                                                                                                                                                                |

### 12.9 `PayslipSummaryDto` / `PayslipDetailDto`

`PayslipSummaryDto` (list row):

| Field         | Source                                                            |
| ------------- | ----------------------------------------------------------------- |
| `id`          | `payslip.id`                                                      |
| `periodLabel` | `payslip.period_label` (frozen at generation)                     |
| `payDate`     | `payslip.pay_date`                                                |
| `netPay`      | `MoneyDto` from `payslip.net_pay_minor_ct` (decrypted in the API) |
| `reference`   | `payslip.reference_no`                                            |

`PayslipDetailDto` adds:

| Field                                                   | Source                                                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `periodStart`, `periodEnd`                              | `payslip.period_start` / `.period_end`                                                                                                                                                                              |
| `paymentMode`                                           | `payslip.payment_mode`                                                                                                                                                                                              |
| `bank`                                                  | `{ name: payslip.bank_name_snapshot, last4: payslip.bank_account_last4 }`                                                                                                                                           |
| `payableDays`, `totalDays`                              | `payslip.payable_days` / `.total_days` → renders `31 / 31`                                                                                                                                                          |
| `lopDays`                                               | `payslip.lop_days`                                                                                                                                                                                                  |
| `grossEarnings`, `totalDeductions`, `netPay`            | decrypted envelopes; the API **asserts** `Σ earning lines == grossEarnings` and `Σ deduction lines == totalDeductions` before responding — a mismatch is `500 INTEGRITY_ASSERTION_FAILED`, never a corrected number |
| `employerPf`, `tds`                                     | `payslip.employer_pf_minor` (nullable ⇒ field omitted), `payslip.tds_minor`                                                                                                                                         |
| `earnings[]`, `deductions[]`, `employerContributions[]` | `payslip_line` filtered by `kind`, ordered by `display_order` — `{ label: label_snapshot, amount: MoneyDto, narration, quantity, rateApplied }`. **The UI never sorts.**                                            |
| `revision`, `status`                                    | `payslip.revision`, `ChipDto` over `ess_payslip_status`                                                                                                                                                             |
| `pdfAvailable`                                          | _(computed)_ `pdf_file_object_id IS NOT NULL`                                                                                                                                                                       |
| `publishedAt`                                           | `payslip_publication.published_at`                                                                                                                                                                                  |

### 12.10 `ExpenseClaimDto`

| Field            | Source                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`, `claimNo`  | `expense_claim.id`, `.claim_no`                                                                                          |
| `title`          | `expense_claim.title`                                                                                                    |
| `category`       | `{ id, code, name }` from `expense_category`                                                                             |
| `spendDate`      | `expense_claim.spend_date`                                                                                               |
| `totalAmount`    | `MoneyDto` from `total_amount_minor` (trigger-maintained Σ of lines)                                                     |
| `approvedAmount` | nullable `MoneyDto`                                                                                                      |
| `status`         | `ChipDto` over `ess_expense_claim_status` (§13.3 mapping)                                                                |
| `note`           | _(computed)_ `manager_note` when `MANAGER_REJECTED`, `finance_note` when `FINANCE_REJECTED`, else omitted                |
| `policyFlags`    | `expense_claim.policy_flag_codes[]`                                                                                      |
| `lines[]`        | `expense_claim_line`: `{ lineNo, description, merchantName, spendDate, amount, taxAmount, isWithinLimit, limitApplied }` |
| `attachments[]`  | `expense_attachment` → `{ id, fileId, filename, kind, scanStatus }`                                                      |
| `paidInCycle`    | `{ id, label, actualPayDate }` from `paid_in_payroll_cycle_id`; omitted when null                                        |
| `canWithdraw`    | _(computed)_ `status IN ('SUBMITTED','PENDING_MANAGER') AND manager_decided_at IS NULL`                                  |
| `version`        | `row_version`                                                                                                            |

### 12.11 `ApprovalTaskDto` — the unified Manager queue card

| Field                | Source                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `id`                 | `approval_task.id`                                                                                     |
| `kind`               | `ChipDto` over `ess_approval_task_kind` → `Leave` **blue**, `Expense` **amber**, `Attendance` **blue** |
| `subject`            | `PersonRefDto` from `subject_employee_id` (gives `initials` + `fullName`)                              |
| `title`              | `approval_task.title` — composed **server-side at creation** from persisted fields                     |
| `subtitle`           | `approval_task.subtitle` (nullable)                                                                    |
| `amount`             | nullable `MoneyDto` from `amount_minor`                                                                |
| `requestedAt`        | `approval_task.requested_at`                                                                           |
| `requestedLabel`     | _(computed)_ `'Requested ' + fmtShort(requested_at)`                                                   |
| `dueAt`, `isOverdue` | `due_at`, _(computed)_ `due_at < now()`                                                                |
| `status`             | `ChipDto` over `ess_approval_task_status`                                                              |
| `decidedAt`          | nullable                                                                                               |
| `decision`           | on history rows: `{ outcome, note, decidedAt, decidedBy: PersonRefDto }` from `approval_decision`      |
| `entity`             | `{ type: "leave_request"                                                                               | "expense_claim" | "attendance_approval" | "document_request", id }` for deep links |
| `version`            | `row_version`                                                                                          |

### 12.12 `NotificationDto`

| Field                | Source                                                                            |
| -------------------- | --------------------------------------------------------------------------------- |
| `id`, `kind`, `tone` | `notification.id`, `.kind`, `.tone`                                               |
| `title`              | `notification.title`                                                              |
| `contextLabel`       | `notification.context_label`                                                      |
| `occurredAt`         | `notification.occurred_at`                                                        |
| `metaLabel`          | _(computed)_ `fmtShort(occurred_at) + ' · ' + context_label` → `31 Aug · Payroll` |
| `deepLink`           | `{ screen: deep_link_screen, params: deep_link_params }`                          |
| `readAt`             | nullable                                                                          |

### 12.13 `PolicyListItemDto` / `PolicyDetailDto`

List item:

| Field                   | Source                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `policyId`, `versionId` | `policy.id`, `policy_version.id`                                                                                       |
| `name`                  | `policy.name`                                                                                                          |
| `versionLabel`          | `policy_version.version_label` (generated `'v'                                                                         |     | major |     | '.' |     | minor`) |
| `updatedLabel`          | `policy_version.last_updated_label`                                                                                    |
| `status`                | `ChipDto` over the **derived** status of `DATA-MODEL.md` §15.4: `ACKNOWLEDGED` green / `OVERDUE` red / `PENDING` amber |
| `dueOn`                 | `policy_assignment.due_on` (nullable ⇒ no "Due …" text)                                                                |
| `acknowledgedAt`        | `policy_acknowledgement.acknowledged_at` (nullable)                                                                    |

Detail adds `owner` (`policy.owner_label`), `summary`, `bodyMarkdown`,
`bodySha256` (hex — echoed back on acknowledge), `appliesToLabel`, `effectiveFrom`,
`nextReviewOn`, `contactEmail` (`policy.contact_email`), `points[]`
(`policy_version_point.text` ordered by `point_no`; **absent array ⇒ the SPA omits the
"What this policy covers" block**), `pdfAvailable` (`pdf_file_object_id IS NOT NULL`),
`acknowledgementText` (`ui_copy` `policy.ack_sentence` — the exact sentence stored with the
acknowledgement), and `requiresAcknowledgement`.

### 12.14 `TicketDto`

| Field                                                             | Source                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `ticketNo`                                                  | `helpdesk_ticket.id`, `.ticket_no`                                                                                                                                                                                                                                                                                                  |
| `category`                                                        | `{ id, code, name }` from `ticket_category`                                                                                                                                                                                                                                                                                         |
| `subject`, `description`                                          |                                                                                                                                                                                                                                                                                                                                     |
| `status`                                                          | `ChipDto` over `ess_ticket_status`                                                                                                                                                                                                                                                                                                  |
| `priority`                                                        | `ess_ticket_priority`                                                                                                                                                                                                                                                                                                               |
| `assignee`                                                        | `PersonRefDto` of the assigned agent, or `null`; `null` renders "unassigned" — a persisted fact                                                                                                                                                                                                                                     |
| `metaLabel`                                                       | _(computed)_ assigned+open → `assignee.fullName + ' · updated ' + rel(updated_at)`; resolved → `'Resolved ' + fmtShort(resolved_at)`; unassigned → `'Opened ' + rel(created_at) + ' · unassigned'`                                                                                                                                  |
| `firstResponseDueAt`, `resolutionDueAt`, `resolvedAt`, `closedAt` | timestamps                                                                                                                                                                                                                                                                                                                          |
| `resolutionSummary`                                               | nullable                                                                                                                                                                                                                                                                                                                            |
| `notificationEmailStatus`                                         | _(HR view only)_ `helpdesk_ticket.email_delivery_status` — the denormalised mirror the dispatcher maintains in the same transaction as the outbox update (`DATA-MODEL.md` §16), so the queue renders the real delivery state in one read and never joins to `email_outbox` per row — surfaces a `FAILED` dispatch as a banner (§14) |
| `attachments[]`, `commentCount`                                   |                                                                                                                                                                                                                                                                                                                                     |
| `version`                                                         | `row_version`                                                                                                                                                                                                                                                                                                                       |

### 12.15 `PayrollCycleDto`

| Field                                                                                    | Source                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`, `periodCode`, `label`                                                              | `payroll_cycle.*`                                                                                                                                                                                                                                                                                                              |
| `periodStart`, `periodEnd`, `scheduledPayDate`, `actualPayDate`                          |                                                                                                                                                                                                                                                                                                                                |
| `status`                                                                                 | `ChipDto` over `ess_payroll_cycle_status`                                                                                                                                                                                                                                                                                      |
| `stepTracker[]`                                                                          | _(computed, from `status` alone)_ the seven mandated stages, each `{ key, label, state: "DONE"                                                                                                                                                                                                                                 | "CURRENT" | "BLOCKED" | "PENDING", blockedReason? }` — see §13.6.1 |
| `employeeCount`, `payslipCount`                                                          |                                                                                                                                                                                                                                                                                                                                |
| `controlTotals`                                                                          | `{ gross, net, deductions }` as `MoneyDto`; **omitted entirely** unless the actor holds `payroll:cycle:read`; `null` members until `CALCULATED`                                                                                                                                                                                |
| `attendancePeriod`                                                                       | `{ id, status, periodCode }`                                                                                                                                                                                                                                                                                                   |
| `inputsLockedAt`, `validatedAt`, `calculatedAt`, `approvedAt`, `publishedAt`, `closedAt` |                                                                                                                                                                                                                                                                                                                                |
| `availableTransitions[]`                                                                 | _(computed)_ the `state_transition` rows from the current state whose `required_permission_code` the actor holds, each `{ toState, label, guardsSatisfied: bool, blockingGuard?: string, blockingReason?: string }` — this is how the Accounts UI disables a button **and states why**, without duplicating the workflow rules |
| `version`                                                                                | `row_version`                                                                                                                                                                                                                                                                                                                  |

### 12.16 `AttendanceRecordDto`

| Field                                                                                                                 | Source                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `employee` (`PersonRefDto`)                                                                                     |                                                                                                                                                   |
| `status`                                                                                                              | `ChipDto` over `ess_attendance_record_status`                                                                                                     |
| `source`                                                                                                              | `ess_attendance_source`                                                                                                                           |
| `calendarDays`, `eligibleDays`, `presentDays`, `paidLeaveDays`, `holidayDays`, `weekOffDays`, `absentDays`, `lopDays` | `attendance_record.*`                                                                                                                             |
| `payableDays`                                                                                                         | `attendance_record.payable_days` — **generated column** `eligible_days - lop_days`; read-only, never writable                                     |
| `overtimeHours`, `hrNote`, `managerNote`                                                                              |                                                                                                                                                   |
| `manager`                                                                                                             | `PersonRefDto` from `manager_employee_id` (the period-end snapshot)                                                                               |
| `dayIdentityHolds`                                                                                                    | _(computed)_ `present+paid_leave+holiday+week_off+absent == eligible` — mirrors `ck_ar__day_identity` so the HR grid can flag a row before Submit |
| `version`                                                                                                             | `row_version`                                                                                                                                     |

### 12.17 `EmployeeProfileDto` (tabbed)

Returned by `GET /me/profile?tab=…`; each tab is an ordered `fields[]` array of
`{ key, label, value, isMasked?, isAvailable }` so the SPA renders the prototype's
label/value grid without knowing the domain. `label` comes from `ui_copy`; `value` is `null`
when the satellite row is absent (**field omitted entirely** when the actor is not entitled).
Tab note text is `ui_copy` keys `profile.tab_note.{personal|employment|bank|emergency}`
(`DATA-MODEL.md` §20.5) — never a literal in the SPA.

---

### 12.18 Server-side formatters — the only ones that exist

Every `*(computed)*` label in this catalogue is produced by one of these four functions, in
`organization.timezone` and `organization.locale` (`Asia/Kolkata`, `en-IN`), in
`packages/shared/src/format.ts`, shared **byte-for-byte** with the SPA so a server label and
a client label of the same value are identical:

| Function            | Definition                                                                                                                                                                                                                                                                                                                                              | Example                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `fmt(date)`         | `Intl.DateTimeFormat(locale, { day:'numeric', month:'short', year:'numeric', timeZone })`                                                                                                                                                                                                                                                               | `29 Sep 2026`                |
| `fmtShort(instant)` | `Intl.DateTimeFormat(locale, { day:'numeric', month:'short', timeZone })` — no year, matching the prototype's `31 Aug · Payroll`                                                                                                                                                                                                                        | `31 Aug`                     |
| `fmtLong(instant)`  | `{ weekday:'long', day:'numeric', month:'long', year:'numeric' }`                                                                                                                                                                                                                                                                                       | `Tuesday, 29 September 2026` |
| `rel(instant)`      | Buckets, **not** a continuous duration, so two callers a second apart render the same string: `< 60 s` → `just now`; `< 60 min` → `N minutes ago`; `< 24 h` → `N hours ago`; `< 7 d` → `N days ago`; otherwise `fmt(instant)`. Computed against `serverTime`, and `serverTime` is in the enclosing response, so the SPA can re-render without drifting. | `2 days ago`                 |
| `periodRange(a, b)` | `a` and `b` are `period_label`s. Same year ⇒ `'<monA> – <monB> <year>'`; different years ⇒ `'<monA> <yearA> – <monB> <yearB>'`; `a == b` ⇒ `a`.                                                                                                                                                                                                         | `Apr – Aug 2026`             |

Three rules bind them:

1. **A range whose two ends are equal collapses to one value**, never `X – X`
   (`LeaveRequestDto.rangeLabel`, `MetricDto.subLabel`).
2. **A pluralised count uses `Intl.PluralRules`**, never `n > 1 ? 's' : ''`; the singular and
   plural forms are two `ui_copy` keys (`leave.days_one` / `leave.days_other`).
3. **A label whose inputs are all null is omitted, not rendered empty.** `daysLabel` with
   `totalDays = null` is not `" days"` — the field does not appear.

`serverTime` (`GET /me`) is the single clock the UI uses for "is this overdue", "is this
window open" and every relative label. The SPA never calls `Date.now()` for a displayed
value; `isOverdue`, `isDeclarationOpen`, `isOpen` and `canWithdraw` are **server-computed
booleans** for exactly this reason.

## 13. Endpoints

Legend for each endpoint block:
**P** = required `permission.code` + ABAC scope · **I** = `Idempotency-Key` required ·
**S** = step-up MFA required · **RL** = rate-limit bucket.
Unless stated otherwise every endpoint can return `401 UNAUTHENTICATED`,
`401 TOKEN_EXPIRED`, `401 TOKEN_STALE`, `403 AUTHZ_DENIED`, `429 RATE_LIMITED`,
`500 INTERNAL_ERROR`; these are omitted from each row's error list to keep it readable.
Unsafe methods can additionally return the three CSRF/origin `403`s of §1.3.

> **Reading `…/decide`.** Where a block below shows `POST …/decide` with an `outcome`
> field, that is shorthand for the pair of dedicated transition endpoints in **§13.19**
> (`…/approve` + `…/reject`), which are canonical and match `docs/WORKFLOWS.md`. The single
> exception is `POST /manager/approvals/:id/decide` (§13.15), which is genuinely polymorphic
> and dispatches to those handlers. Request bodies, guards, audit rows and response shapes
> are identical either way.

### 13.1 Auth — `/api/v1/auth`

#### `POST /auth/login`

**P** public · **I** no · **S** n/a · **RL** `ip` 10/15min, `account` 10/15min, `ip` 60/60min

```
body .strict():
  email     z.string().email().max(254).toLowerCase()
  password  z.string().min(12).max(256)          // never logged, never echoed
```

**`200 OK` — no MFA, or MFA already satisfied for this device is NOT a concept here: MFA is always required when enrolled.**

```jsonc
{ "status": "AUTHENTICATED", "accessToken": "eyJ…", "expiresIn": 600, "tokenType": "Bearer" }
```

- `Set-Cookie: __Host-wd_rt=…` and `Set-Cookie: __Host-wd_csrf=…` (§4.2).

**`200 OK` — MFA challenge required** (the normal path for every enrolled user):

```jsonc
{
  "status": "MFA_REQUIRED",
  "mfaToken": "<opaque, 300 s, single-use, bound to this attempt>",
  "methods": ["TOTP", "RECOVERY_CODE"], // RECOVERY_CODE present iff unused codes remain
  "recoveryCodesRemaining": 8, // mfa_recovery_code count WHERE used_at IS NULL
}
```

No cookie is set at this step. The refresh family is created only after MFA succeeds.

**`200 OK` — enrolment required** (privileged role without MFA, or grace expired):

```jsonc
{
  "status": "MFA_ENROLMENT_REQUIRED",
  "enrolmentToken": "<opaque, 900 s>",
  "graceExpiredAt": "2026-…",
}
```

Errors: `401 INVALID_CREDENTIALS` (**identical** for unknown email, wrong password and
disabled-but-existing account — enumeration resistance) · `403 PASSWORD_CHANGE_REQUIRED`
(`details.changeToken`, a 900 s single-use token scoped to `POST /auth/password/forced-change`
and to nothing else; no session, no cookie and no access token are issued) · `423 ACCOUNT_LOCKED` +
`Retry-After` · `429 RATE_LIMITED` · `503 UNAVAILABLE` (rate-limit store down — auth fails
**closed**).

Side effects: one `login_attempt` row with the hashed email/IP and the `ess_login_outcome`;
an `audit_event` `LOGIN`; the progressive-lockout ladder of `SECURITY.md` §2.6.

#### `POST /auth/mfa/challenge`

**P** public (bearer-less; authorised by `mfaToken`) · **I** no · **RL** keyed on `sha256(mfaToken)` **and** on the `app_user_id` the token resolves to **and** on `ip`: 5/5 min on each, then a 15 min cooldown. There is no authenticated `user` at this point, so a `user` bucket would be unkeyable; the token's subject is the equivalent and is known before the code is compared. A recovery-code attempt consumes the same buckets.

```
body: mfaToken z.string().min(20).max(512)
      code     z.string().regex(/^\d{6}$/)            // TOTP
    | recoveryCode z.string().regex(/^[0-9a-hjkmnp-tv-z]{5}-[…]{5}-[…]{5}$/i)
      exactly one of code | recoveryCode  (z.union, .strict())
```

**`200 OK`** → the `AUTHENTICATED` body above, `Set-Cookie` pair issued,
`refresh_token.mfa_satisfied_at = now()`, `mfa_credential.last_used_counter` advanced in the
same transaction (TOTP replay protection).

Errors: `401 MFA_CHALLENGE_INVALID` (unknown/expired/replayed `mfaToken`) ·
`401 MFA_CODE_INVALID` (`details.attemptsRemaining` while > 0) · `423 ACCOUNT_LOCKED` ·
`429 RATE_LIMITED`.

Using a recovery code additionally: marks it `used_at`, emits `AUTH.MFA_RECOVERY_USED`,
queues a `SECURITY_ALERT` email, and sets a flag that forces TOTP re-enrolment before the
next login (surfaced as `"mustReEnrolMfa": true` on `GET /me`).

#### `POST /auth/mfa/step-up`

**P** `auth:login` (authenticated) · **I** no · **RL** `user` 5/5min

`body: { code }` → **`200 OK`** `{ accessToken, expiresIn }` with a refreshed `mfa_at` claim.
Errors as above.

#### `POST /auth/refresh`

**P** public (cookie-authenticated) · **I** no · **RL** `session` 60/5min · **CSRF** required

No request body. Reads `__Host-wd_rt`.

**`200 OK`** `{ "accessToken", "expiresIn": 600, "tokenType": "Bearer" }` + a rotated
`__Host-wd_rt` cookie. Rotation is `presented.rotated_at = now()` + a new row with
`parent_token_id`, `generation + 1`, the same `family_id` and the same
`family_absolute_expires_at` — all in one transaction.

Errors: `401 UNAUTHENTICATED` (no cookie) · `401 SESSION_REVOKED` — returned for an
expired family, a revoked family, **and for reuse detection**, which additionally revokes the
whole family, deletes it, bumps `app_user.token_epoch`, writes
`AUTH.REFRESH_REUSE_DETECTED` (CRITICAL), queues the "signed out everywhere" email and
raises an alert (`SECURITY.md` §3.3). The 10-second same-IP+same-UA grace for the immediate
predecessor re-returns the already-issued successor rather than minting a new one ·
`403 CSRF_*` · `429 RATE_LIMITED`.

#### `POST /auth/logout`

**P** `auth:login` · **CSRF** required · **`204 No Content`**
Revokes the current family (`revoked_reason = 'LOGOUT'`), clears both cookies with
`Max-Age=0`, writes `LOGOUT`. Clearing the cookie alone is never treated as logout.

#### `POST /auth/logout-all`

**P** `auth:login` · **CSRF** required · **`204 No Content`**
Revokes **every** family for the user, bumps `app_user.token_epoch` (so every outstanding
access token dies within ≤ 600 s), clears cookies, writes `LOGOUT` with
`metadata.scope = "ALL_SESSIONS"`.

#### `GET /auth/sessions`

**P** `auth:login` · scope SELF · **unpaged**

```jsonc
{
  "data": [
    {
      "sessionId": "…",
      "isCurrent": true,
      "deviceLabel": "Chrome · macOS",
      "ipCity": "Bengaluru", // refresh_token.ip_city, persisted at issue; null when unresolved
      "issuedAt": "…",
      "lastRotatedAt": "…",
      "expiresAt": "…",
      "mfaSatisfiedAt": "…",
    },
  ],
}
```

All fields from `refresh_token` (`device_label`, `ip_city`, `issued_at`, `rotated_at`,
`expires_at`, `mfa_satisfied_at`). **`ip_city` is a persisted column written once at token
issue** from the GeoIP lookup of the issuing request; it is never recomputed at read time and
never inferred from an ASN in the mapper. When the lookup returned nothing the column is
`NULL` and the field is `null`, which the SPA renders as `—`. A best-effort value derived on
the fly would be a number-shaped string with no row behind it — exactly what Directive 2
forbids.
The raw token and its hash are
never returned.

#### `DELETE /auth/sessions/:sessionId`

**P** `auth:login` (own) · **S** no · **`204`** · `404 NOT_FOUND` if not the actor's family.

#### `GET /auth/me` → see `GET /me` (§13.2). `/auth/me` is **not** provided; identity lives at `/me`.

#### `POST /auth/password/change`

**P** `auth:login` · **I** yes · **S** **yes** · **R** **yes** · **RL** write

```
body: currentPassword z.string().min(12).max(256)
      newPassword     z.string().min(12).max(256)
```

**`204 No Content`.** In one transaction: Argon2id rehash, `password_history` append,
`token_epoch += 1`, **all** refresh families revoked, `locked_until` cleared, `PASSWORD_RESET`-
class audit, `SECURITY_ALERT` email queued. The client must then re-login.

Errors: `401 INVALID_CREDENTIALS` (wrong `currentPassword`) ·
`422 PASSWORD_REJECTED` (`details.reason` ∈ `TOO_SHORT|BREACHED|TOO_COMMON` — HIBP
k-anonymity with graceful offline fallback, `SECURITY.md` §2.3) · `422 PASSWORD_REUSED` ·
`403 MFA_STEP_UP_REQUIRED`.

#### `POST /auth/reauth`

**P** `auth:login` · **I** no · **RL** `user` 5/5min then 15 min cooldown · **CSRF** not required

`body .strict(): { password z.string().min(12).max(256) }`
**`200 OK`** `{ "accessToken", "expiresIn": 600, "tokenType": "Bearer" }` with a refreshed
`reauth_at` claim. Nothing else changes: no cookie is rotated, no `token_epoch` moves.
Errors: `401 INVALID_CREDENTIALS` (which also advances the progressive-lockout ladder of
`SECURITY.md` §2.6, so this route cannot be used as an offline password oracle) ·
`423 ACCOUNT_LOCKED` · `429 RATE_LIMITED`.

#### `POST /auth/accept-invitation`

**P** public (authorised by `invitationToken`) · **I** yes · **RL** `ip` 10/60min, `token` 5/60min

```
body .strict():
  invitationToken z.string().min(32).max(256)
  newPassword     z.string().min(12).max(256)
  acceptTerms     z.literal(true)
```

This is the only way an invited account becomes usable: `POST /hr/employees/:id/invite`
creates the `app_user` with `password_hash = NULL`, and **no default password exists anywhere
in the system** (`SECURITY.md` §10.1), so without this route an invited employee could never
sign in. Lookup is by `user_invitation.token_fpr`, then a constant-time hash compare;
`attempt_count` is incremented on every failure and the invitation is revoked (with a
`SECURITY_ALERT`) at 5.

In one transaction (`WORKFLOWS.md` USR-2): set `password_hash` (Argon2id + pepper),
`password_updated_at`, `email_verified_at`, `terms_accepted_at`; `app_user.status`
`INVITED → ACTIVE`; `user_invitation.accepted_at`; grant the `EMPLOYEE` role; write
`USER.ACTIVATED`.

**`200 OK`** — `{ "status": "MFA_ENROLMENT_REQUIRED", "enrolmentToken": "<opaque, 900 s>" }`
when the employee's persona set requires MFA (`HR`, `ACCOUNTS`, `MANAGER`) or
`organization_setting.mfa_enforced_at` is set; otherwise the `AUTHENTICATED` body of
`/auth/login` with the cookie pair. **No session is ever issued before the password is set.**
Errors: `401 RESET_TOKEN_INVALID` (unknown, expired, used or revoked — one code for all four,
for enumeration resistance) · `422 PASSWORD_REJECTED` · `429 RATE_LIMITED`.

#### `POST /auth/password/forced-change`

**P** public (authorised by `changeToken` from the `403 PASSWORD_CHANGE_REQUIRED` body) ·
**I** yes · **RL** `ip` 10/60min

`body .strict(): { changeToken, newPassword }`
The forced-change path deliberately does **not** reuse `POST /auth/password/change`: that
route requires a live session, `currentPassword` and a step-up assertion, none of which a
user holding only a must-change credential can produce. Same transaction as
§2.8 of `SECURITY.md` (hash, history append, `token_epoch += 1`, every refresh family
deleted, lock cleared, `password_must_change` cleared, audit, `SECURITY_ALERT` email).
**MFA is not bypassed** — the next login still requires TOTP. **`204`.**
Errors: `401 RESET_TOKEN_INVALID` · `422 PASSWORD_REJECTED` · `422 PASSWORD_REUSED`.

#### `POST /auth/password-reset/request`

**P** public · **I** no · **RL** `ip` 5/60min, `account` 3/60min

`body: { email }` → **always `202 Accepted`** with an empty body, whether or not the address
exists, whether or not it is throttled. The mail goes only to the **work email on record**,
never to an address supplied in the request. One live token per user (issuing marks prior
tokens used); 15-minute expiry; SHA-256-only storage.

#### `POST /auth/password-reset/confirm`

**P** public · **I** yes · **RL** `ip` 10/60min

`body: { token z.string().min(32).max(256), newPassword }` → **`204`**.
Same transaction as §2.8 of `SECURITY.md`: write hash, append history, mark token used,
`token_epoch += 1`, delete all refresh families, clear lock, audit. **MFA is not bypassed** —
the next login still requires TOTP.
Errors: `401 RESET_TOKEN_INVALID` (unknown/expired/used — one code for all three) ·
`422 PASSWORD_REJECTED` · `422 PASSWORD_REUSED`.

#### `POST /auth/mfa/enrol`

**P** `auth:login` · **I** yes · **R** **yes** (`reauth_at ≤ 300 s`, §4.3) · **S** no — a user with no confirmed credential cannot satisfy `mfa_at` · **RL** `user` 5/60min

`body: {}` → **`201 Created`**

```jsonc
{
  "credentialId": "…uuid",
  "secret": "JBSWY3DPEHPK3PXP", // shown EXACTLY ONCE, never returned again
  "otpauthUri": "otpauth://totp/Widedrop%20ESS:priya.raghavan@widedrop.com?secret=…&issuer=Widedrop%20ESS&algorithm=SHA1&digits=6&period=30",
  "algorithm": "SHA1",
  "digits": 6,
  "periodSeconds": 30,
}
```

The credential is created with `confirmed_at = NULL`; it does **not** satisfy MFA yet. The QR
is rendered client-side from `otpauthUri`; the URI is never logged.

#### `POST /auth/mfa/verify-enrolment`

**P** `auth:login` · **I** yes · **R** yes · `body: { credentialId, code }`

**`200 OK`**

```jsonc
{
  "confirmedAt": "2026-09-29T…Z",
  "recoveryCodes": ["k3f9m-2xq7t-9bd4w", "…"], // 10 codes, shown EXACTLY ONCE
  "recoveryCodesRemaining": 10,
}
```

Sets `confirmed_at`, issues one `mfa_recovery_code` batch (Argon2id-hashed), bumps
`token_epoch`, queues `MFA_ENROLLED` email.
Errors: `401 MFA_CODE_INVALID` · `409 CONFLICT` (`details.reason = "ALREADY_CONFIRMED"`).

#### `POST /auth/mfa/recovery-codes`

**P** `auth:login` · **I** yes · **S** yes · **R** yes · **RL** `user` 5/60min
**P** `auth:login` · **I** yes · **S** yes · **RL** `user` 5/60min
Regenerates the batch (invalidating the previous one). Same `recoveryCodes` response shape.

#### `DELETE /auth/mfa/credentials/:id`

**P** `auth:login` · **S** yes · **R** yes · **`204`**
**P** `auth:login` · **S** yes · **`204`**
Refused with `409 CONFLICT` (`details.reason = "MFA_MANDATORY_FOR_ROLE"`) when the user holds
`HR`, `ACCOUNTS` or `MANAGER` — those personas cannot be MFA-less (`SECURITY.md` §2.7).

#### `GET /auth/mfa/status`

**P** `auth:login` · **unpaged**
`{ "isEnrolled": true, "confirmedAt": "…", "method": "TOTP", "recoveryCodesRemaining": 8,
   "graceExpiresAt": null, "mustReEnrol": false }`
`recoveryCodesRemaining ≤ 2` is what drives the Home "Set up two-step verification" to-do — a
real persisted count.

### 13.2 Me — identity, shell bootstrap, profile

#### `GET /me`

**P** `profile:read:self` · scope SELF · **unpaged**

The single identity read. The SPA never decodes the JWT for display data.

```jsonc
{
  "user": {
    "id": "…",
    "email": "priya.raghavan@widedrop.com",
    "status": "ACTIVE",
    "mustChangePassword": false,
    "mustReEnrolMfa": false,
  },
  "employee": {
    "id": "…",
    "employeeNumber": "WDT-01847", // employee.employee_number
    "fullName": "Priya Raghavan", // employee.full_name
    "preferredName": "Priya", // employee.preferred_name ?? first_name
    "initials": "PR", // employee.initials
    "workEmail": "priya.raghavan@widedrop.com",
    "title": "Senior Software Engineer", // designation.title via employment_as_of(:me, today)
    "department": "Platform Engineering", // department.name
    "accentColourHex": "#1B365D", // department.accent_colour_hex
    "location": "Bengaluru", // location.city
    "siteLabel": "Ecospace Tower A", // location.site_label
    "employmentStatus": "ACTIVE",
    "dateOfJoining": "2022-07-11",
    "photoUrl": null,
  }, // null ⇒ render initials, never a stock image
  "personas": ["EMPLOYEE", "MANAGER"], // live user_role → role.persona
  "permissions": ["profile:read:self", "leave:request:create:self", "…"], // the union; SPA uses it for COSMETIC gating only
  "organization": {
    "id": "…",
    "displayName": "Widedrop",
    "portalName": "Employee portal",
    "logoUrl": "/api/v1/org/logo"   // §11.1; null when organization.logo_file_object_id IS NULL,
    "timezone": "Asia/Kolkata",
    "locale": "en-IN",
    "currency": "INR",
    "currencyMinorUnitScale": 2,
    "helpdeskEmail": "helpdesk@widedroptech.com",
    "expenseCutoffDayOfMonth": 25,
  "security": { "mfaEnrolled": true, "recoveryCodesRemaining": 8,
                "mustReEnrolMfa": false, "graceExpiresAt": null },   // = GET /auth/mfa/status
  },
  "fiscalYear": {
    "id": "…",
    "label": "FY 2026–27",
    "startDate": "2026-04-01",
    "endDate": "2027-03-31",
  },
  "leavePeriod": { "id": "…", "label": "Leave year Jan – Dec 2026" },
  "serverTime": "2026-09-29T04:31:07.412Z",
}
```

Every field above is a persisted column or reference-data label. `permissions` exists so the
SPA can hide controls; `apps/web/src/lib/can.ts` carries the comment that hiding UI is not a
security control (`SECURITY.md` §4.8) — the server re-checks on every route.
Errors: `403 ACCOUNT_DISABLED`.

#### `GET /me/bootstrap`

**P** `profile:read:self` · **unpaged** · **RL** read

One call that fills the shell so the app does not fire eight requests on load. Everything is
derived; nothing new is invented.

```jsonc
{
  "nav": {
    "groups": [
      { "name": "Overview", "items": [{ "id": "home", "label": "Home", "badge": null }] },
      { "name": "Manager", "items": [{ "id": "approvals", "label": "Approvals", "badge": 3 }] },
    ],
  },
  "badges": { "approvals": 3, "policiesPending": 2, "notificationsUnread": 4 },
  "todayLabel": "Tue, 29 Sep 2026",
}
```

| Field                        | Source                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nav.groups`                 | The static nav manifest in `packages/shared` **filtered by the token's permissions** (`approvals` needs **`approval:task:read:team`** — the Manager grant of `DATA-MODEL.md` §3.3; `approval:task:read:any` is HR-only and is **not** what gates this item. HR and Accounts groups need their own persona permissions.). Group order and labels are fixed by `DESIGN-SYSTEM.md` §6. |
| `badges.approvals`           | `SELECT count(*) FROM approval_task WHERE organization_id = :org AND assignee_employee_id = :me AND status = 'PENDING'` — identical to `GET /manager/approvals`.`page.total`, so the badge and the list can never disagree (index `ix_at__assignee_pending`). **`0` ⇒ the value is `0` and the SPA renders no badge element at all** — it does not render a "0" chip.               |
| `badges.policiesPending`     | `count(policy_assignment WHERE employee_id=:me AND superseded_at IS NULL AND NOT EXISTS(acknowledgement))`                                                                                                                                                                                                                                                                          |
| `badges.notificationsUnread` | `count(notification WHERE recipient_app_user_id=:u AND read_at IS NULL AND dismissed_at IS NULL)`                                                                                                                                                                                                                                                                                   |
| `todayLabel`                 | `now()` rendered in `organization.timezone`/`locale`                                                                                                                                                                                                                                                                                                                                |

#### `GET /me/home`

**P** `profile:read:self` · **unpaged** · **RL** read

The Home screen in one authorized read. Each block is independently nullable so a missing
block collapses instead of fabricating a value.

```jsonc
{
  "greetingKey": "GOOD_MORNING",                 // hour(now() in org tz) <12 | <17 | else — computed, label from ui_copy
  "subHeader": "Tuesday, 29 September 2026 · Bengaluru · Ecospace Tower A",
  "latestPayslip": {                              // null when nothing is published
    "id": "…", "periodLabel": "August 2026",
    "netPay": { "amountMinor": 12756000, "currency": "INR" },
    "payDate": "2026-08-31", "pdfAvailable": true
  },
  "latestPayslipEmptyState": null,                // present iff latestPayslip is null (§1.6)
  "leaveBalancesTop3": [ { "leaveTypeName": "Earned leave", "availableDays": 14.5,
                           "entitlementDays": 18, "percent": 81 } ],
  "approvals": { "pendingCount": 3, "preview": [ ApprovalTaskDto ] },   // omitted entirely when the actor is not a manager
  "announcements": [ { "id": "…", "title": "…", "categoryLabel": "People Ops", "publishedAt": "…" } ],
  "holidays": [ { "id": "…", "name": "Gandhi Jayanti", "date": "2026-10-02" } ],
  "holidayCalendarName": "Bengaluru calendar",
  "team": [ { "person": PersonRefDto, "todayStatus": { "value": "AVAILABLE", "label": "Available", "tone": "GREEN" } } ],
  "todos": [ { "kind": "POLICY_ACK", "title": "Acknowledge Information Security Policy v4.2",
               "subtitle": "Due 15 Oct 2026 · IT & Security", "actionLabel": "Review",
               "tone": "AMBER", "deepLink": { "screen": "policies", "params": { "versionId": "…" } } } ]
  ,
  "partial": []                                   // block keys whose 400 ms budget expired (§18.6)
}
```

Sources are exactly `DATA-MODEL.md` §20.2. Specifically:
`percent` _(computed)_ `round(available_days / nullif(entitlement_days,0) * 100)`;
`entitlement_days = 0` ⇒ `percent: null` and the SPA hides the bar and shows a plain count.
`team[].todayStatus` = `EXISTS(leave_request_day … leave_date = :today AND day_fraction > 0 AND request APPROVED)` →
`ON_LEAVE` amber, a `PUBLIC` holiday on that employee's calendar → `HOLIDAY` gray, else
`AVAILABLE` green. `team` is **omitted** when the actor has no direct reports (the Manager
column collapses). `todos` is `[]` when there is nothing — the SPA then omits the whole
block, matching the prototype's `hasTodos`.

**`todos[].kind` is a closed enum**, and every member is a persisted fact with a query behind
it. There is no "suggested action" that is not one of these:

| `kind`                    | Emitted when                                                         | `tone`                       | Source query                                                           |
| ------------------------- | -------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| `POLICY_ACK`              | a live `policy_assignment` with no acknowledgement                   | `AMBER`, `RED` past `due_on` | `DATA-MODEL.md` §20.6 — one row per pending assignment                 |
| `APPROVALS_PENDING`       | the actor has ≥ 1 `approval_task` `PENDING` assigned to them         | `BLUE`                       | the `badges.approvals` count; omitted at `0`                           |
| `MFA_ENROL`               | `mfa_credential` has no `confirmed_at`                               | `RED`                        | `GET /auth/mfa/status`.`isEnrolled = false`                            |
| `MFA_RECOVERY_LOW`        | `recoveryCodesRemaining ≤ 2`                                         | `AMBER`                      | `count(mfa_recovery_code WHERE used_at IS NULL)`                       |
| `TAX_DECLARATION_DUE`     | the declaration window is open and the declaration is `DRAFT`/absent | `AMBER`                      | `fiscal_year.declaration_window_*` + `employee_tax_declaration.status` |
| `TAX_PROOF_DUE`           | the proof window is open and `tax.all_items_have_proof` is false     | `AMBER`                      | `fiscal_year.proof_window_*`                                           |
| `TICKET_AWAITING_YOU`     | a ticket of the actor's is `WAITING_ON_EMPLOYEE`                     | `AMBER`                      | `helpdesk_ticket.status`                                               |
| `ATTENDANCE_APPROVAL_DUE` | the actor owns an `attendance_approval` slice that is `PENDING`      | `AMBER`, `RED` past `due_at` | `attendance_approval.status`                                           |

`title`/`subtitle`/`actionLabel` come from `ui_copy` keys `todo.<kind>.*` with persisted
params; the SPA composes none of them. An empty `todos` array is the normal steady state and
is exactly what the prototype's "Needs your attention" block collapses on.

**`partial`.** Each block has a 400 ms budget. A block that exceeds it returns `null`, its
key is appended to `partial[]`, and the SPA refetches that one block from its dedicated
endpoint (`GET /me/payslips`, `/me/leave/balances`, `/manager/approvals`,
`/me/announcements`, `/leave/holidays`, `/me/reporting-line`). `partial` is `[]` on the happy
path and is **never** used to hide an empty result — an empty block returns `[]`/`null` with
its `emptyState`, not a `partial` entry.

#### `GET /me/profile`

**P** `profile:read:self`; the `personal` and `bank` tabs additionally require
`profile:read_sensitive:self` for their masked values · scope SELF · **unpaged**

`query: tab z.enum(['personal','employment','bank','emergency']).default('personal')`

```jsonc
{
  "header": {
    "initials": "PR",
    "fullName": "Priya Raghavan",
    "titleLine": "Senior Software Engineer · Platform Engineering",
    "chips": ["WDT-01847", "Bengaluru", "Full-time", "Joined 11 Jul 2022"],
  },
  "tab": "personal",
  "fields": [
    { "key": "FULL_NAME", "label": "Full name", "value": "Priya Raghavan", "isAvailable": true },
    {
      "key": "DATE_OF_BIRTH",
      "label": "Date of birth",
      "value": "14 Feb 1994",
      "isAvailable": true,
      "isMasked": false,
    },
    {
      "key": "PERSONAL_EMAIL",
      "label": "Personal email",
      "value": "p•••••@gmail.com",
      "isAvailable": true,
      "isMasked": true,
    },
  ],
  "note": "Name and date of birth changes need a government ID. …", // ui_copy profile.tab_note.personal
}
```

Field sources per tab are exactly `DATA-MODEL.md` §20.5. Notable:
`TENURE` on the employment tab is _(computed)_ `age(:today, employee.date_of_joining)`
formatted `4 years 2 months` — **never stored**. `ESI` renders the literal
`Not applicable` when `employee_statutory_id.is_applicable = false` — a persisted fact, not a
UI fallback. A satellite row that does not exist ⇒ the field is **omitted from `fields[]`**;
a tab with no fields returns `fields: []` plus an `emptyState` with code
`PROFILE_TAB_EMPTY`.

Reading the `personal` or `bank` tab writes an `audit_event` with `action='READ_SENSITIVE'`
because the mapper touched encrypted columns.

#### `POST /me/profile/unmask`

**P** `profile:read_sensitive:self` (own) — for another employee, `profile:read_sensitive:any` on the HR route ·
**I** no · **S** **yes** · **RL** `user` 30/h + CRITICAL alert on trip

`body: { fieldKey z.enum(['PAN','AADHAAR','UAN','PF_ACCOUNT','ESI','BANK_ACCOUNT_NUMBER','DATE_OF_BIRTH','PERSONAL_MOBILE','PERSONAL_EMAIL','CURRENT_ADDRESS','PERMANENT_ADDRESS']) }`

**`200 OK`** `{ "fieldKey": "PAN", "value": "AXYPRQ1234K", "unmaskedAt": "…" }`
One field per call, deliberately: a mass unmask is N audit events, not one
(`SECURITY.md` §7.5). Errors: `403 MFA_STEP_UP_REQUIRED` · `403 READ_SENSITIVE_DENIED` ·
`404 NOT_FOUND` (no such statutory/bank row).

#### `POST /me/profile-change-requests` _(canonical; `/me/profile/change-request` is not routed)_

**P** `profile:change_request:create:self` · **I** yes · **S** yes when `section='bank'` or `'statutory'` · **RL** write

```
body .strict():
  section     z.enum(['personal','employment','bank','statutory','emergency'])
  fieldKey    z.string().max(64)              // must be a known key for that section
  requestedValue z.string().max(300)          // NEVER a masked string; a value matching the mask pattern ⇒ 422
  reason      z.string().trim().min(10).max(500)
  proofFileId z.string().uuid().optional()    // required when section ∈ {bank, statutory} or fieldKey ∈ {FULL_NAME, DATE_OF_BIRTH}
```

T
h
i
s

i
s

t
h
e

p
r
o
t
o
t
y
p
e
'
s

"
R
e
q
u
e
s
t

a

c
h
a
n
g
e
"

b
u
t
t
o
n
.

I
t

d
o
e
s

-
-

n
o
t * *

m
u
t
a
t
e

t
h
e

p
r
o
f
i
l
e
,

a
n
d

i
t

d
o
e
s

-
-

n
o
t * *

o
p
e
n

a

h
e
l
p
-

d
e
s
k

t
i
c
k
e
t
:

i
t

c
r
e
a
t
e
s

a

`p
r
o
f
i
l
e
_
c
h
a
n
g
e
_
r
e
q
u
e
s
t`

( +

o
n
e

`p
r
o
f
i
l
e
_
c
h
a
n
g
e
_
r
e
q
u
e
s
t
_
f
i
e
l
d`

r
o
w

p
e
r

f
i
e
l
d
,

h
o
l
d
i
n
g

b
o
t
h

`p
r
o
p
o
s
e
d
_
v
a
l
u
e`

a
n
d

`p
r
e
v
i
o
u
s
_
v
a
l
u
e`
,

`
D
A
T
A
-

M
O
D
E
L
.
m
d
`

§
5
.
1
1
)
,

w
h
i
c
h

h
a
s

i
t
s

o
w
n

s
t
a
t
e

m
a
c
h
i
n
e
,

i
t
s

o
w
n

H
R

q
u
e
u
e

a
n
d

i
t
s

o
w
n

a
u
d
i
t
e
d

`A
P
P
R
O
V
E
D
→
A
P
P
L
I
E
D`

s
y
s
t
e
m

t
r
a
n
s
i
t
i
o
n
.

R
o
u
t
i
n
g

a

p
r
o
f
i
l
e

c
h
a
n
g
e

t
h
r
o
u
g
h

`h
e
l
p
d
e
s
k
_
t
i
c
k
e
t`

w
o
u
l
d

l
o
s
e

t
h
e

f
i
e
l
d
-

l
e
v
e
l

b
e
f
o
r
e
/
a
f
t
e
r

t
h
a
t

m
a
k
e
s

t
h
e

c
h
a
n
g
e

r
e
v
i
e
w
a
b
l
e
,

a
n
d

w
o
u
l
d

l
e
t

a

t
i
c
k
e
t

b
e

"
r
e
s
o
l
v
e
d
"

w
i
t
h
o
u
t

t
h
e

p
r
o
f
i
l
e

e
v
e
r

c
h
a
n
g
i
n
g
.

I
n

o
n
e

t
r
a
n
s
a
c
t
i
o
n
:

i
n
s
e
r
t

t
h
e

r
e
q
u
e
s
t

w
i
t
h

`
s
t
a
t
u
s

=

S
U
B
M
I
T
T
E
D
`
,

`s
e
c
t
i
o
n`
,

`r
e
a
s
o
n`
,

`p
r
o
o
f
_
f
i
l
e
_
o
b
j
e
c
t
_
i
d`
;

i
n
s
e
r
t

o
n
e

f
i
e
l
d

r
o
w

p
e
r

c
h
a
n
g
e
d

f
i
e
l
d
;

c
r
e
a
t
e

o
n
e

`a
p
p
r
o
v
a
l
_
t
a
s
k`

(
k
i
n
d

`P
R
O
F
I
L
E
_
C
H
A
N
G
E
_
R
E
Q
U
E
S
T`
)

f
o
r

t
h
e

H
R

b
u
s
i
n
e
s
s

p
a
r
t
n
e
r
;

e
m
i
t

`P
R
O
F
I
L
E
_
C
H
A
N
G
E
_
S
U
B
M
I
T
T
E
D`
;

w
r
i
t
e

t
h
e

`a
u
d
i
t
_
e
v
e
n
t`
.

A

`S
E
C
U
R
I
T
Y
_
A
L
E
R
T`

e
m
a
i
l

a
d
d
i
t
i
o
n
a
l
l
y

g
o
e
s

t
o

t
h
e

e
m
p
l
o
y
e
e

f
o
r

`
s
e
c
t
i
o
n

∈

{
b
a
n
k
,

s
t
a
t
u
t
o
r
y
}
`

(
`W
O
R
K
F
L
O
W
S
.
m
d`

P
C
R
-

5
)
,

b
e
c
a
u
s
e

a

b
a
n
k
-

d
e
t
a
i
l

c
h
a
n
g
e

r
e
q
u
e
s
t

i
s

t
h
e

c
l
a
s
s
i
c

p
a
y
r
o
l
l
-

d
i
v
e
r
s
i
o
n

a
t
t
a
c
k

a
n
d

t
h
e

a
c
c
o
u
n
t

h
o
l
d
e
r

m
u
s
t

l
e
a
r
n

o
f

i
t

o
u
t

o
f

b
a
n
d
.

-
-

`
2
0
1

C
r
e
a
t
e
d
` * *

→

`
{

"
c
h
a
n
g
e
R
e
q
u
e
s
t
"
:

P
r
o
f
i
l
e
C
h
a
n
g
e
R
e
q
u
e
s
t
D
t
o
,

"
s
l
a
H
o
u
r
s
"
:

8

}
`

—

t
h
e

t
o
a
s
t

s
h
o
w
s

t
h
e

-
-

p
e
r
s
i
s
t
e
d * *

`r
e
q
u
e
s
t
N
o`

a
n
d

t
h
e

S
L
A

f
r
o
m

`o
r
g
a
n
i
z
a
t
i
o
n
_
s
e
t
t
i
n
g`
.

I
t

n
e
v
e
r

s
h
o
w
s

a

g
u
e
s
s
e
d

n
u
m
b
e
r
.

`P
r
o
f
i
l
e
C
h
a
n
g
e
R
e
q
u
e
s
t
D
t
o`
:

`
{

i
d
,

r
e
q
u
e
s
t
N
o
,

s
e
c
t
i
o
n
,

s
t
a
t
u
s
:

C
h
i
p
D
t
o
,

r
e
a
s
o
n
,

r
e
q
u
e
s
t
e
d
A
t
,

d
e
c
i
d
e
d
A
t
,

d
e
c
i
s
i
o
n
N
o
t
e
,

a
p
p
l
i
e
d
A
t
,

f
i
e
l
d
s
:

[
{

f
i
e
l
d
K
e
y
,

l
a
b
e
l
,

p
r
o
p
o
s
e
d
V
a
l
u
e
,

p
r
e
v
i
o
u
s
V
a
l
u
e
,

i
s
M
a
s
k
e
d

}
]
,

p
r
o
o
f
:

{

f
i
l
e
I
d
,

f
i
l
e
n
a
m
e
,

s
c
a
n
S
t
a
t
u
s

}

|

o
m
i
t
t
e
d
,

v
e
r
s
i
o
n

}
`
.

`p
r
o
p
o
s
e
d
V
a
l
u
e`

a
n
d

`p
r
e
v
i
o
u
s
V
a
l
u
e`

a
r
e

-
-

m
a
s
k
e
d

t
o

t
h
e

s
a
m
e

r
u
l
e

a
s

t
h
e

p
r
o
f
i
l
e

t
a
b

t
h
e
y

c
a
m
e

f
r
o
m * *
,

s
o

t
h
e

c
h
a
n
g
e
-

r
e
q
u
e
s
t

s
c
r
e
e
n

c
a
n
n
o
t

b
e
c
o
m
e

a

w
a
y

t
o

r
e
a
d

a

s
t
a
t
u
t
o
r
y

i
d

i
n

t
h
e

c
l
e
a
r
.

**`201 Created`** → `{ "ticket": TicketDto, "slaHours": 8 }` — the toast shows the
**persisted** `ticket.ticketNo` and the SLA from
`ticket_category.first_response_sla_hours`. It never shows a guessed number.

Errors: `400 VALIDATION_FAILED` · `422 BUSINESS_RULE_VIOLATED` (`details.rule="MASKED_VALUE_SUBMITTED"`)
· `422 ATTACHMENT_REQUIRED` · `422 FILE_NOT_CLEAN` · `403 MFA_STEP_UP_REQUIRED`.

#### `GET /me/emergency-contacts`

**P** `profile:read_sensitive:self` · **unpaged**
`{ "data": [ { "id", "priority", "contactName": MaskedValueDto|string, "relationship",
               "relationshipLabel", "phone": MaskedValueDto|string } ] }`
This route is `/me`, so the subject is always the owner and values are always full. The
masked projection (`contact_name_mask`/`phone_mask`) exists for the **manager and HR**
surfaces — `GET /manager/employees/:employeeId/emergency-contacts`
(**P** `profile:read:team`, scope `DIRECT_REPORTS`, depth 1 only, masked, audited
`READ_SENSITIVE`) and `GET /hr/employees/:id` (**P** `profile:read_sensitive:any`, full) —
and never on this one. A Manager holds no `profile:read_sensitive:*` code
(`DATA-MODEL.md` §3.3), which is why the manager view is mask-only.

#### `POST /me/emergency-contacts`

**P** `profile:update:self` · **I** yes · **RL** write

```
body: priority z.number().int().min(1).max(5)
      contactName  z.string().trim().min(2).max(120)
      relationship z.enum(ess_dependent_relationship)
      relationshipNote z.string().max(120).optional()   // required when relationship='OTHER'
      phone z.string().regex(/^\+?[0-9 ]{8,20}$/)
```

**`201`** the created contact. `409 DUPLICATE_RESOURCE` (`constraint="emergency_contact_priority"`).

#### `PATCH /me/emergency-contacts/:id` — **If-Match** required · partial of the above · **`200`**

#### `DELETE /me/emergency-contacts/:id` — **`204`** · `409 CONFLICT` when it is the last remaining priority-1 contact.

### 13.3 Directory — `/api/v1/directory`

#### `GET /directory/people`

**P** `directory:read` · scope ORG (directory-listed only) · **page/limit** · **RL** `user` 60/min

```
query: q      z.string().trim().max(120).optional()
       page   z.coerce.number().int().min(1).default(1)
       limit  z.coerce.number().int().min(1).max(100).default(25)
       sort   z.enum(['fullName','department','location']).default('fullName')
       departmentId / locationId  z.string().uuid().optional()
```

**`200`** `{ "data": [ DirectoryPersonDto ], "page": { page, limit, total, totalPages } }`

`DirectoryPersonDto` is a **hard field allowlist** — name, title, department, location,
work email, work phone, and nothing else:

| Field                                                   | Source                                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `employeeId`, `fullName`, `initials`, `accentColourHex` | as `PersonRefDto`                                                                         |
| `title`, `department`, `location`                       | `designation.title`, `department.name`, `location.city` via `employment_as_of(id, today)` |
| `workEmail`                                             | `employee.work_email`                                                                     |
| `workPhone`                                             | `employee.work_phone` — **omitted** unless the actor holds `directory:read_contact`       |

Predicate: `is_directory_listed = true AND employment_status IN ('ACTIVE','ON_LEAVE','NOTICE_PERIOD')`.
`q` matches `full_name || title || department || city` case-insensitively.
`page.total` is the real count under the same predicate — this is the header's
"N people shown" and nothing else. Zero matches ⇒ `data: []`, `total: 0`, plus
`emptyState.code = "DIRECTORY_NO_MATCHES"` with `params.query`.

No personal email, no mobile, no address, no DOB, no salary, no manager's manager — those are
not in the DTO, so the response schema cannot serialise them even if a query returned them
(`SECURITY.md` §5.1).

#### `GET /directory/people/:employeeId`

**P** `directory:read` · **unpaged**
`DirectoryPersonDto` + `reportsTo: PersonRefDto | null` (current `PRIMARY`
`employee_manager` → `employee.full_name`; omitted when there is none).
`404 NOT_FOUND` when not directory-listed or not in the org.

#### `GET /me/reporting-line`

**P** `directory:read` · scope SELF · **unpaged**

```jsonc
{ "ancestors": [ { "person": PersonRefDto, "relationLabel": "Your manager", "depth": 1 },
                 { "person": PersonRefDto, "relationLabel": "Your manager's manager", "depth": 2 } ],
  "self":      { "person": PersonRefDto, "relationLabel": "You" },
  "reports":   [ { "person": PersonRefDto, "relationLabel": "Reports to you", "depth": 1 } ] }
```

From `employee_reporting_closure` (`ancestor_employee_id = :me AND depth = 1` for reports;
the longest `descendant_employee_id = :me` path for ancestors). Both arrays empty ⇒ the SPA
omits the strip entirely.

#### `GET /search`

**P** `directory:read` (plus per-kind permissions applied inside) · **unpaged, capped at 8** · **RL** `user` 30/min

`query: q z.string().trim().min(2).max(120)`

```jsonc
{
  "data": [
    {
      "kind": "MODULE",
      "label": "Payslips",
      "sub": "Pay & tax",
      "deepLink": { "screen": "payslips", "params": {} },
    },
    { "kind": "PERSON", "label": "Neha Kulkarni", "sub": "Software Engineer II", "…": "…" },
    { "kind": "POLICY", "label": "Leave Policy", "sub": "v2.4", "…": "…" },
    {
      "kind": "PAYSLIP",
      "label": "August 2026",
      "sub": null,
      "params": { "netPay": { "amountMinor": 12756000, "currency": "INR" } },
      "deepLink": { "screen": "payslips", "params": { "payslipId": "…" } },
    },
  ],
}
```

Four scoped sub-queries (`SECURITY.md` §4.10): `MODULE` over the permission-filtered nav
manifest; `PERSON` over the directory DTO (max 4); `POLICY` over the actor's
`policy_assignment` join (max 3); `PAYSLIP` over the `payslip_publication` visibility gate
(max 3). **Search can never surface a row the user could not open.** Zero results ⇒
`data: []` and the SPA renders the prototype's "No matches for …" row.
`sub` is `null` on a `PAYSLIP` row and the SPA renders it from `params.netPay` with the
locale rule of `DESIGN-SYSTEM.md` §10 — the API sends
`{"netPay": MoneyDto}`, never a formatted currency string (§1.5).

### 13.4 Leave — `/api/v1/me/leave*`, `/api/v1/manager/leave-requests`

> **Reference-data reads use `org:read`.** `DATA-MODEL.md` §3.1 seeds no
> `<resource>:type:read` code, and CI invariant 4 (§17) forbids a `GET` from declaring a
> write-class permission such as `leave:request:create:self`. Every reference collection in
> this contract — leave types, expense categories, ticket categories, FAQ articles, letter
> templates, benefit plans, tax sections, holiday calendars — therefore declares `org:read`,
> which every persona holds, and filters rows by `is_active` plus any eligibility rule the
> table itself carries. Reference data is not sensitive; what is sensitive is the _employee's_
> data under it, and that is guarded by the route that returns it.

#### `GET /leave/types`

**P** `org:read` (reference data; a write-class code on a `GET` is forbidden by CI invariant 4, §17) + eligibility filtering by `leave_entitlement_rule` · **unpaged** · reference data
`{ "data": [ { "id", "code": "EL", "name": "Earned leave", "shortName": "EL",
               "unit": "DAY", "isPaid": true, "minNoticeDays": 3,
               "requiresAttachmentAfterDays": null, "maxConsecutiveDays": null,
               "allowsNegativeBalance": false, "displayOrder": 0 } ] }`
Filtered to the types the actor is eligible for via `leave_entitlement_rule`
(`DATA-MODEL.md` §20.7) and `is_active`, ordered by `display_order`. **The dropdown order is
the DB's, never a client sort.**

#### `GET /me/leave/balances`

**P** `leave:balance:read:self` · **unpaged**

```jsonc
{
  "leavePeriod": { "id": "…", "label": "Leave year Jan – Dec 2026" },
  "data": [
    {
      "leaveTypeId": "…",
      "leaveTypeName": "Earned leave",
      "displayOrder": 0,
      "availableDays": 14.5, // leave_balance.available_days (GENERATED column)
      "entitlementDays": 18, // leave_balance.entitlement_days
      "pendingDays": 0, // leave_balance.pending_days (soft hold)
      "usedDays": 3.5,
      "accruedDays": 13.5,
      "carriedInDays": 4.5,
      "percent": 81,
    },
  ],
} // computed: round(available/nullif(entitlement,0)*100); null when entitlement=0
```

No `leave_balance` row for the current period ⇒ `data: []` with
`emptyState.code = "LEAVE_NO_BALANCES"` and `params.nextAccrualOn` from the scheme's
`accrual_on_day_of_month`. **`0 / 0` is never sent** (`DATA-MODEL.md` §8.4).

#### `GET /leave/holidays`

**P** `holiday:read` · **unpaged**
`query: from z.coerce.date().optional() (default :today), to (default :today + 1 year), kind z.enum(['PUBLIC','RESTRICTED']).optional(), limit z.coerce.number().int().max(50).optional()`
`{ "calendar": { "id", "name": "Bengaluru calendar" },
   "data": [ { "id", "name": "Dussehra · Vijaya Dashami", "date": "2026-10-20",
               "kind": "PUBLIC", "isObservedShift": false } ] }`
Calendar resolved by `holiday_calendar_for(:me, :today)`. `day`/`month`/`weekday` are
formatted by the SPA from `date` — the API sends one date, not three strings.

#### `GET /me/leave-requests`

**P** `leave:request:read:self` · **cursor**, sort `start_date DESC, id DESC`
`query: status z.enum(ess_leave_request_status).optional(), leavePeriodId uuid optional (default current), from/to dates optional, limit, cursor`
`{ "data": [ LeaveRequestDto ], "page": { … } }`
Empty ⇒ `emptyState.code = "LEAVE_NO_REQUESTS"`.

#### `POST /me/leave-requests`

**P** `leave:request:create:self` · scope SELF · **I** yes · **S** no · **RL** write

```
body .strict():
  leaveTypeId   z.string().uuid()
  startDate     z.string().date()                       // YYYY-MM-DD
  endDate       z.string().date()
  startPortion  z.enum(['FULL','FIRST_HALF','SECOND_HALF']).default('FULL')
  endPortion    z.enum(['FULL','FIRST_HALF','SECOND_HALF']).default('FULL')
  reason        z.string().trim().max(2000).optional()
  attachmentFileId z.string().uuid().optional()
  submit        z.boolean().default(true)               // false ⇒ stays DRAFT
```

**There is no `employeeId` field and no `totalDays` field.** Both are server-derived.

Server computation, in one transaction:

1. `total_days` = `working_days(:me, startDate, endDate)` adjusted for the portions
   (`DATA-MODEL.md` §7.3). The prototype's browser-side weekend loop is **advisory only**;
   the server's count is authoritative and is what is persisted. Weekends come from
   `organization.week_off_days` / `employee_employment.weekly_off_days`, holidays from the
   employee's `holiday_calendar` — not from `getDay() !== 0 && !== 6`.
2. One `leave_request_day` row per calendar day in the span, with `is_working_day`,
   `day_fraction` and `counts_toward_balance`. `leave_request.total_days` is then set by its
   trigger as `SUM(day_fraction) FILTER (counts_toward_balance)`.
3. Guards in order: `leave.period_open` → `leave.no_overlap` → `leave.sufficient_balance`
   → `leave.min_notice` → `leave.attachment_if_required` → `leave.manager_exists`.
4. On submit: `status = PENDING_APPROVAL`, `approver_employee_id` = the current `PRIMARY`
   manager snapshot, `balance_after_days` snapshot, `leave_balance.pending_days += total_days`,
   one `approval_task` (kind `LEAVE_REQUEST`, `title`/`subtitle` composed now from persisted
   fields), one `notification` (`LEAVE_SUBMITTED` → manager), one `audit_event`.

**`201 Created`** · `Location: /api/v1/me/leave-requests/{id}` · body `LeaveRequestDto`
(carrying the **server-computed** `totalDays`, the resolved `approver`, and the persisted
`balanceAfterDays` — the toast reads "Leave request sent to {approver.fullName}" from this
response, never from a client guess).

Errors: `400 VALIDATION_FAILED` (incl. `endDate < startDate`) ·
`422 NO_WORKING_DAYS_IN_RANGE` · `422 LEAVE_DATES_OVERLAP` ·
`422 INSUFFICIENT_LEAVE_BALANCE` · `422 MIN_NOTICE_NOT_MET` · `422 ATTACHMENT_REQUIRED` ·
`422 FILE_NOT_CLEAN` · `422 MANAGER_NOT_RESOLVED` ·
`409 GUARD_FAILED` (`guardKey="leave.period_open"`) · `409 IDEMPOTENCY_IN_PROGRESS`.

#### `GET /me/leave-requests/:id` — **P** `leave:request:read:self` · `LeaveRequestDto` + `ETag`.

#### `POST /me/leave-requests/:id/withdraw`

**P** `leave:request:withdraw:self` · **I** yes · **If-Match** required
`body: { reason z.string().trim().max(500).optional() }`
**`200`** the updated `LeaveRequestDto` with `status.value = 'WITHDRAWN'`.
Ledger effects per `DATA-MODEL.md` §8.6 (from `PENDING_APPROVAL`: release `pending_days`;
from `APPROVED`: a `CONSUMPTION_REVERSAL` ledger row pointing at the original consumption).
Errors: `409 STATE_TRANSITION_NOT_ALLOWED` · `409 GUARD_FAILED`
(`leave.starts_in_future` or `leave.not_yet_locked_by_attendance`) · `409 VERSION_CONFLICT`.

#### `GET /manager/leave-requests`

**P** `leave:request:read:team` · scope REPORTING_CHAIN (`depth ≥ 1`) · **cursor**
`query: status (default PENDING_APPROVAL), employeeId uuid optional (must be in scope, else 404), from/to, limit, cursor`
`LeaveRequestDto` + `employee: PersonRefDto`.

#### `POST /manager/leave-requests/:id/decide`

**P** `leave:request:approve:team` · scope REPORTING_CHAIN · **I** yes · **If-Match** required · **RL** `user` 200/h (bulk rubber-stamping signal)

```
body: outcome z.enum(['APPROVE','REJECT'])
      note    z.string().trim().min(10).max(500).optional()   // REQUIRED when outcome='REJECT'
```

Guards: `approval.actor_is_assigned_approver`, `leave.period_open`, and on reject
`approval.note_required`. One transaction: `leave_request` transition, `approval_task` →
`APPROVED`/`REJECTED`, one append-only `approval_decision`, the leave ledger effect,
`LEAVE_DECIDED` notification, `LEAVE_DECISION` email, `audit_event`.
**`200`** `{ "leaveRequest": LeaveRequestDto, "approvalTask": ApprovalTaskDto }`.
Errors: `403 SELF_APPROVAL_FORBIDDEN` (structurally impossible via `ck_at__not_self`, but
checked and audited) · `404 NOT_FOUND` (not in the actor's subtree) ·
`409 STATE_TRANSITION_NOT_ALLOWED` (already decided) · `409 VERSION_CONFLICT` ·
`422 BUSINESS_RULE_VIOLATED` (`rule="NOTE_REQUIRED"`).

#### `GET /manager/leave/team-calendar`

**P** `leave:request:read:team` · **unpaged**
`query: from, to (max 92 days apart)`
`{ "data": [ { "person": PersonRefDto, "days": [ { "date": "2026-10-05", "dayFraction": 1.0,
   "leaveTypeName": "Earned leave", "status": "APPROVED" } ] } ] }`
From `leave_request_day` joined to approved/pending requests of direct reports. Drives the
Approvals aside note ("Upcoming: … Dussehra week has 1 approved leave"); **zero rows ⇒ the
note is omitted entirely**, never replaced with "0 leaves".

### 13.5 Attendance — HR capture, Manager approval, Employee view

-
-

S
y
s
t
e
m

t
r
a
n
s
i
t
i
o
n
s
. * *

S
e
v
e
r
a
l

t
r
a
n
s
i
t
i
o
n
s

i
n

t
h
i
s

w
o
r
k
f
l
o
w

a
r
e

p
e
r
f
o
r
m
e
d

b
y

t
h
e

s
e
r
v
e
r

a
s

t
h
e

c
l
o
s
i
n
g

a
c
t

o
f

a
n
o
t
h
e
r

e
n
d
p
o
i
n
t
'
s

t
r
a
n
s
a
c
t
i
o
n
,

a
n
d

t
h
e
r
e
f
o
r
e

h
a
v
e

-
-

n
o

e
n
d
p
o
i
n
t

o
f

t
h
e
i
r

o
w
n * *
.

T
h
e
y

a
r
e

l
i
s
t
e
d

h
e
r
e

s
o

§
1
3
.
1
9
'
s

"
o
n
e

r
o
u
t
e

p
e
r

t
r
a
n
s
i
t
i
o
n
"

r
u
l
e

i
s

c
o
m
p
l
e
t
e

r
a
t
h
e
r

t
h
a
n

s
i
l
e
n
t
l
y

v
i
o
l
a
t
e
d
,

a
n
d

s
o

n
o

c
l
i
e
n
t

e
v
e
r

w
a
i
t
s

f
o
r

a

b
u
t
t
o
n

t
h
a
t

d
o
e
s

n
o
t

e
x
i
s
t
:

|

M
a
c
h
i
n
e

|

T
r
a
n
s
i
t
i
o
n

|

P
e
r
f
o
r
m
e
d

i
n
s
i
d
e

|

G
u
a
r
d

t
h
a
t

m
u
s
t

a
l
r
e
a
d
y

h
o
l
d

|

|
-

-
-

|
-

-
-

|
-

-
-

|
-

-
-

|

|

`a
t
t
e
n
d
a
n
c
e
_
p
e
r
i
o
d`

|

`
H
R
_
S
U
B
M
I
T
T
E
D

→

M
A
N
A
G
E
R
_
A
P
P
R
O
V
A
L
_
P
E
N
D
I
N
G
`

|

`
P
O
S
T

/
h
r
/
a
t
t
e
n
d
a
n
c
e
/
p
e
r
i
o
d
s
/
:
i
d
/
s
u
b
m
i
t
`

|

s
l
i
c
e
s

c
r
e
a
t
e
d

≥

1

|

|

`a
t
t
e
n
d
a
n
c
e
_
p
e
r
i
o
d`

|

`
M
A
N
A
G
E
R
_
A
P
P
R
O
V
A
L
_
P
E
N
D
I
N
G

→

A
P
P
R
O
V
E
D
`

|

t
h
e

-
-

l
a
s
t * *

`
P
O
S
T

/
m
a
n
a
g
e
r
/
a
t
t
e
n
d
a
n
c
e
/
a
p
p
r
o
v
a
l
s
/
:
i
d
/
a
p
p
r
o
v
e
`

|

e
v
e
r
y

s
l
i
c
e

`A
P
P
R
O
V
E
D`

|

|

`a
t
t
e
n
d
a
n
c
e
_
p
e
r
i
o
d`

|

`
A
P
P
R
O
V
E
D

→

L
O
C
K
E
D
`

|

`
P
O
S
T

/
p
a
y
r
o
l
l
/
c
y
c
l
e
s
/
:
i
d
/
c
a
l
c
u
l
a
t
e
`

|

r
u
n

s
t
a
r
t
e
d

|

|

`p
a
y
r
o
l
l
_
c
y
c
l
e`

|

`
I
N
P
U
T
S
_
L
O
C
K
E
D

→

A
T
T
E
N
D
A
N
C
E
_
S
U
B
M
I
T
T
E
D
`

|

`
P
O
S
T

/
h
r
/
a
t
t
e
n
d
a
n
c
e
/
p
e
r
i
o
d
s
/
:
i
d
/
s
u
b
m
i
t
`

|

—

|

|

`p
a
y
r
o
l
l
_
c
y
c
l
e`

|

`
A
T
T
E
N
D
A
N
C
E
_
S
U
B
M
I
T
T
E
D

→

A
T
T
E
N
D
A
N
C
E
_
A
P
P
R
O
V
E
D
`

|

t
h
e

l
a
s
t

s
l
i
c
e

a
p
p
r
o
v
a
l

|

e
v
e
r
y

s
l
i
c
e

`A
P
P
R
O
V
E
D`

|

|

`p
a
y
r
o
l
l
_
c
y
c
l
e`

|

`
V
A
L
I
D
A
T
I
N
G

→

V
A
L
I
D
A
T
E
D

\
|

V
A
L
I
D
A
T
I
O
N
_
F
A
I
L
E
D
`

|

t
h
e

v
a
l
i
d
a
t
i
o
n

w
o
r
k
e
r

|

`p
a
y
r
o
l
l
.
n
o
_
e
r
r
o
r
_
v
a
l
i
d
a
t
i
o
n
s`

|

|

`p
a
y
r
o
l
l
_
c
y
c
l
e`

|

`
C
A
L
C
U
L
A
T
I
N
G

→

C
A
L
C
U
L
A
T
E
D

\
|

V
A
L
I
D
A
T
I
O
N
_
F
A
I
L
E
D
`

|

t
h
e

p
a
y
r
o
l
l

r
u
n

w
o
r
k
e
r

|

`p
a
y
r
o
l
l
.
r
u
n
_
s
u
c
c
e
e
d
e
d`
,

`p
a
y
r
o
l
l
.
p
a
y
s
l
i
p
_
c
o
u
n
t
_
m
a
t
c
h
e
s
_
e
m
p
l
o
y
e
e
_
c
o
u
n
t`
,

`p
a
y
r
o
l
l
.
c
o
n
t
r
o
l
s
_
b
a
l
a
n
c
e`

|

|

`p
a
y
r
o
l
l
_
r
u
n`

|

`
Q
U
E
U
E
D

→

R
U
N
N
I
N
G

→

S
U
C
C
E
E
D
E
D

\
|

F
A
I
L
E
D
`

|

t
h
e

p
a
y
r
o
l
l

r
u
n

w
o
r
k
e
r
,

l
e
a
s
e
-

h
e
l
d

|

`e
s
s
_
o
p
s
.
b
a
c
k
g
r
o
u
n
d
_
j
o
b`

l
e
a
s
e

|

|

`p
a
y
r
o
l
l
_
i
n
p
u
t
_
b
a
t
c
h`

|

`
U
P
L
O
A
D
I
N
G

→

P
A
R
S
E
D

\
|

P
A
R
S
E
_
F
A
I
L
E
D
`

|

`
P
O
S
T

…
/
i
n
p
u
t
-

b
a
t
c
h
e
s
`

|

`p
a
y
r
o
l
l
.
f
i
l
e
_
c
l
e
a
n`

|

|

`p
r
o
f
i
l
e
_
c
h
a
n
g
e
_
r
e
q
u
e
s
t`

|

`
A
P
P
R
O
V
E
D

→

A
P
P
L
I
E
D
`

|

t
h
e

a
p
p
l
y

w
o
r
k
e
r

|

`p
r
o
f
i
l
e
.
t
a
r
g
e
t
_
r
o
w
_
u
n
c
h
a
n
g
e
d
_
s
i
n
c
e
_
s
u
b
m
i
t`

|

|

`e
x
p
e
n
s
e
_
c
l
a
i
m`

|

`
Q
U
E
U
E
D
_
F
O
R
_
P
A
Y
M
E
N
T

→

R
E
I
M
B
U
R
S
E
D
`

|

`
P
O
S
T

/
p
a
y
r
o
l
l
/
c
y
c
l
e
s
/
:
i
d
/
p
u
b
l
i
s
h
`

|

t
h
e

c
l
a
i
m
'
s

b
a
t
c
h

i
s

`S
E
N
T
_
T
O
_
P
A
Y
R
O
L
L`

i
n
t
o

t
h
a
t

c
y
c
l
e

|

|

`r
e
i
m
b
u
r
s
e
m
e
n
t
_
b
a
t
c
h`

|

`
S
E
N
T
_
T
O
_
P
A
Y
R
O
L
L

→

P
A
I
D
`

|

`
P
O
S
T

/
p
a
y
r
o
l
l
/
c
y
c
l
e
s
/
:
i
d
/
p
u
b
l
i
s
h
`

|

a
s

a
b
o
v
e

|

|

`b
e
n
e
f
i
t
_
e
n
r
o
l
m
e
n
t`

|

`
E
N
R
O
L
L
E
D

\
|

P
E
N
D
I
N
G
_
D
O
C
U
M
E
N
T
S

→

L
A
P
S
E
D
`

|

t
h
e

n
i
g
h
t
l
y

`
b
e
n
e
f
i
t
-

l
a
p
s
e
`

j
o
b

|

`e
f
f
e
c
t
i
v
e
_
t
o`

p
a
s
s
e
d

|

|

`a
n
n
o
u
n
c
e
m
e
n
t`

|

`
S
C
H
E
D
U
L
E
D

→

P
U
B
L
I
S
H
E
D
`

|

t
h
e

`
a
n
n
o
u
n
c
e
m
e
n
t
-

p
u
b
l
i
s
h
`

j
o
b

|

`p
u
b
l
i
s
h
_
a
t`

p
a
s
s
e
d

|

E
a
c
h

w
r
i
t
e
s

i
t
s

o
w
n

`a
u
d
i
t
_
e
v
e
n
t`

w
i
t
h

`
a
c
t
o
r
_
a
p
p
_
u
s
e
r
_
i
d

=

N
U
L
L
`

a
n
d

`
a
c
t
o
r
_
k
i
n
d

=

'
S
Y
S
T
E
M
'
`
,

n
a
m
i
n
g

t
h
e

t
r
i
g
g
e
r
i
n
g

`r
e
q
u
e
s
t
_
i
d`
,

s
o

a

s
y
s
t
e
m

t
r
a
n
s
i
t
i
o
n

i
s

a
s

t
r
a
c
e
a
b
l
e

a
s

a

h
u
m
a
n

o
n
e
.

A

s
y
s
t
e
m

t
r
a
n
s
i
t
i
o
n

i
s

-
-

n
e
v
e
r * *

e
x
p
o
s
e
d

a
s

a

r
o
u
t
e
,

a
n
d

C
I

i
n
v
a
r
i
a
n
t

3
a

(
§
1
7
)

a
s
s
e
r
t
s

e
x
a
c
t
l
y

t
h
a
t
:

e
v
e
r
y

`s
t
a
t
e
_
t
r
a
n
s
i
t
i
o
n`

s
e
e
d

r
o
w

i
s

e
i
t
h
e
r

b
o
u
n
d

t
o

o
n
e

r
o
u
t
e

-
-

o
r * *

m
a
r
k
e
d

`
i
s
_
s
y
s
t
e
m

=

t
r
u
e
`

a
n
d

l
i
s
t
e
d

a
b
o
v
e
.

> This is steps 2 and 3 of the mandated payroll workflow. **Accounts holds neither
> `attendance:submit` nor `attendance:approve:*`** — the payroll operator cannot manufacture
> their own attendance inputs (`DATA-MODEL.md` §3.3).

#### `GET /hr/attendance/periods`

**P** `attendance:read:any` · **page/limit**, sort `start_date DESC`
`{ "data": [ AttendancePeriodDto ], "page": {…} }`

`AttendancePeriodDto`: `id`, `periodCode`, `label`, `startDate`, `endDate`,
`totalCalendarDays`, `status` (`ChipDto`), `hrSubmittedAt`, `approvalsCompletedAt`,
`lockedAt`, `reopenedAt`, `reopenReason`, `version`, plus:

| Field                                   | Source                                                                                                                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordCount` / `expectedEmployeeCount` | `count(attendance_record)` / count of active employees on `end_date`                                                                                                                                                                      |
| `sliceSummary`                          | `[{ manager: PersonRefDto, recordCount, status, decidedAt }]` from `attendance_approval`                                                                                                                                                  |
| `payrollCycle`                          | `{ id, status, periodCode }` — the 1:1 cycle                                                                                                                                                                                              |
| `canSubmit`                             | _(computed)_ all three submit guards hold                                                                                                                                                                                                 |
| `submitBlockers[]`                      | _(computed)_ `[{ guardKey, message, params }]` — e.g. `attendance.payroll_inputs_locked` → _"Accounts has not locked payroll inputs for August 2026 yet."_ This is how the HR screen states the reason rather than showing a dead button. |

#### `GET /hr/attendance/periods/:id/records`

**P** `attendance:read:any` · **cursor**, sort `employee.employee_number`
`query: status, managerEmployeeId, departmentId, q (name/number), limit, cursor`
`{ "data": [ AttendanceRecordDto ], "page": {…},
   "controlTotals": { "recordCount": 214, "totalPayableDays": 6412.5, "totalLopDays": 18.0 } }`
Control totals are recomputed live and are what `attendance_submission` freezes on submit.

#### `PUT /hr/attendance/periods/:id/records/:employeeId`

**P** `attendance:capture` · **If-Match** required · **RL** write

```
body .strict():
  eligibleDays   z.number().multipleOf(0.5).min(0)
  presentDays    z.number().multipleOf(0.5).min(0)
  paidLeaveDays  z.number().multipleOf(0.5).min(0)
  holidayDays    z.number().multipleOf(0.5).min(0)
  weekOffDays    z.number().multipleOf(0.5).min(0)
  absentDays     z.number().multipleOf(0.5).min(0)
  lopDays        z.number().multipleOf(0.5).min(0)
  overtimeHours  z.number().min(0).max(400).optional()
  hrNote         z.string().trim().max(500).optional()
```

`payableDays` is **not accepted** — it is the generated column `eligible_days - lop_days`.
Server asserts `ck_ar__day_identity` before writing.
**`200`** `AttendanceRecordDto`.
Errors: `422 DAY_IDENTITY_VIOLATED` (`details.expectedEligibleDays`, `suppliedSum`) ·
`409 GUARD_FAILED` (`guardKey="attendance.period_is_open"`, i.e. the period has left `OPEN`)
· `409 VERSION_CONFLICT`.

#### `POST /hr/attendance/periods/:id/records:bulk`

**P** `attendance:capture` · **I** yes · **RL** file-upload bucket

```
body: sourceFileId z.string().uuid()      // a CLEAN file_object with purpose ATTENDANCE_UPLOAD
      mode z.enum(['UPSERT','REPLACE']).default('UPSERT')
```

Parses the CSV/XLSX in a worker (50 000-row / 60-column caps, no formula evaluation,
`SECURITY.md` §5.3.9), writes `attendance_record` rows with
`source = 'HR_BULK_UPLOAD'` and `source_file_object_id`, and returns a **row-level report**:

**`200 OK`**

```jsonc
{
  "sourceFileId": "…",
  "rowCountTotal": 214,
  "rowCountValid": 211,
  "rowCountRejected": 3,
  "rejections": [
    {
      "rowNo": 42,
      "employeeNumber": "WDT-01903",
      "reason": "DAY_IDENTITY_VIOLATED",
      "message": "Day counts total 30.0 but eligible days are 31.0",
    },
  ],
  "controlTotals": { "totalPayableDays": 6412.5, "totalLopDays": 18.0 },
}
```

Valid rows are committed; rejected rows are not. Nothing is silently coerced.
Errors: `422 FILE_NOT_CLEAN` · `422 FILE_NOT_OWNED` · `422 ROW_VALIDATION_FAILED` when
**every** row failed · `409 GUARD_FAILED` when the period is not `OPEN`.

#### `POST /hr/attendance/periods/:id/submit`

**P** `attendance:submit` · **I** yes · **If-Match** required · **RL** write

```
body: note z.string().trim().max(500).optional()
      declaredRecordCount z.number().int().min(0)          // control: must equal the actual count
      declaredTotalPayableDays z.number().multipleOf(0.5)  // control: must equal the actual sum
```

**This endpoint is the enforcement point of "Accounts uploads before HR submits."** Guards,
in order (`DATA-MODEL.md` §9.5):

1. `attendance.payroll_inputs_locked` — the linked `payroll_cycle.status` **must** be
   `INPUTS_LOCKED`. If it is not, `409 GUARD_FAILED` with
   `details = { guardKey, cycleStatus, periodLabel }` and the message
   _"Accounts has not locked payroll inputs for August 2026 yet."_
2. `attendance.all_active_employees_have_records`
3. `attendance.day_identity_holds` (re-checked in bulk)

Then, in one transaction: insert `attendance_submission` (`record_count`,
`employee_count_expected`, `total_payable_days`, `total_lop_days`,
`payload_sha256` over the canonical JSON of every submitted record — the traceability
anchor); move every `attendance_record` `DRAFT → SUBMITTED`; move the period
`OPEN → HR_SUBMITTED → MANAGER_APPROVAL_PENDING`; create one `attendance_approval` **per
distinct `manager_employee_id`** with its slice control totals and `due_at`; create one
`approval_task` (kind `ATTENDANCE_PERIOD`) and one `ATTENDANCE_APPROVAL_PENDING`
notification per manager; move the `payroll_cycle` `INPUTS_LOCKED → ATTENDANCE_SUBMITTED`.

**`200`** `{ "period": AttendancePeriodDto, "submissionId": "…", "payloadSha256": "…",
"slicesCreated": 14 }`.
Errors: `409 GUARD_FAILED` · `409 STATE_TRANSITION_NOT_ALLOWED` ·
`422 CONTROL_TOTAL_MISMATCH` (declared vs actual) · `409 VERSION_CONFLICT`.

#### `POST /hr/attendance/periods/:id/reopen`

**P** `attendance:reopen` · **I** yes · **If-Match** required
`body: { reason z.string().trim().min(10).max(500) }`
Guards `attendance.cycle_not_calculated` (from `APPROVED`) or
`attendance.cycle_not_published` (from `LOCKED`), plus `approval.note_required`.
**`200`** `AttendancePeriodDto`. There is **no** path that reopens a period whose cycle has
published — a correction there is a new cycle (`DATA-MODEL.md` §10.2).

#### `GET /manager/attendance/approvals`

**P** `attendance:approve:team` · scope DIRECT_REPORTS/REPORTING_CHAIN · **page/limit**
`{ "data": [ { "id", "period": { id, label, periodCode },
               "status": ChipDto, "recordCount": 4,
               "totalPayableDays": 118.0, "totalLopDays": 1.0,
               "assignedAt", "dueAt", "isOverdue", "decidedAt", "decisionNote",
               "version" } ], "page": {…} }`

#### `GET /manager/attendance/approvals/:id/records`

**P** `attendance:approve:team` · **cursor**
`AttendanceRecordDto` rows in the slice — the manager sees day counts for their reports and
**no** salary figure anywhere in this payload.

#### `POST /manager/attendance/approvals/:id/decide`

**P** `attendance:approve:team` · **I** yes · **If-Match** required · **RL** `user` 200/h

```
body: outcome z.enum(['APPROVE','RETURN'])
      note    z.string().trim().min(10).max(500).optional()   // REQUIRED when RETURN
```

`APPROVE`: slice → `APPROVED`, its records `SUBMITTED → APPROVED`, an `approval_decision`,
the `approval_task` closed. When it is the **last** pending slice the system (not the user)
moves the period `MANAGER_APPROVAL_PENDING → APPROVED` and the cycle
`ATTENDANCE_SUBMITTED → ATTENDANCE_APPROVED`, emitting `PAYROLL_CYCLE_STATE` to Accounts.
`RETURN`: slice → `REJECTED`, records → `REJECTED`, `decision_note` stored; the period can
then be reopened by HR (`attendance.any_slice_rejected`).

**`200`** `{ "approval": …, "periodStatus": ChipDto, "cycleStatus": ChipDto }` — the manager
sees the workflow advance from persisted state.
Errors: `403 SELF_APPROVAL_FORBIDDEN` (a manager's own record routes to their skip-level,
else HRBP escalation) · `409 STATE_TRANSITION_NOT_ALLOWED` · `409 VERSION_CONFLICT` ·
`422 BUSINESS_RULE_VIOLATED` (`rule="NOTE_REQUIRED"`).

#### `POST /hr/attendance/approvals/:id/escalate`

**P** `attendance:approve:any` · **I** yes · **S** no
`body: { reason z.string().trim().min(10).max(500), escalateToEmployeeId z.string().uuid().optional() }`
Guard `attendance.approval_overdue` — **HR may only escalate after `due_at` has passed**.
Sets `status = AUTO_ESCALATED`, `escalated_to_user_id`, `escalation_reason`; audited.
`escalateToEmployeeId` defaults, in order, to the slice manager's own **primary manager**,
then to the employee's **HR business partner**, then to the actor. It must resolve to an
`ACTIVE` employee who is **not** the slice manager and **not** the subject of any record in
the slice (`ck_at__not_self` applies to the re-created task), else
`422 BUSINESS_RULE_VIOLATED` (`rule="ESCALATION_TARGET_INVALID"`). The original slice's
`approval_task` is closed and a new one is created for the escalation target, so the queue
and the badge stay the same single query.
`409 GUARD_FAILED` (`guardKey="attendance.approval_overdue"`, `details.dueAt`).

#### `GET /me/attendance`

**P** `attendance:read:self` · **unpaged**
`query: periodId uuid optional (default: the latest period whose status is APPROVED or LOCKED)`
Returns the employee's own `AttendanceRecordDto` **minus** `manager`/`hrNote` (internal) plus
`period` and the derived `payableLabel = payableDays + ' / ' + eligibleDays`, the same numerator and denominator `PayslipDetailDto` uses (`payslip.payable_days` / `payslip.total_days`, where `total_days = eligible_days`), so the prototype's `31 / 31` means the same thing on both screens.
A record that is still `DRAFT` or `SUBMITTED` is **not** returned to the employee — they see
`emptyState.code = "ATTENDANCE_NOT_FINALISED"` with `params.periodLabel` and
`params.periodStatus`. No provisional day count is ever shown.

### 13.6 Payroll (Accounts) — `/api/v1/payroll`

> Guard rails restated: **a payslip row cannot exist before `CALCULATED`, and cannot be read
> by an employee before a live `payslip_publication` row exists.** Every step below refuses
> until its prerequisite state is reached, and says which one.

#### 13.6.1 The step tracker

`PayrollCycleDto.stepTracker` is computed **from `payroll_cycle.status` alone** and renders
the seven mandated stages. Because enum ordering carries no meaning (§1.5), each stage's
`DONE` test is an explicit membership list, written out here and seeded as `ui_copy` labels:

| #   | `key`                  | `label`                            | `DONE` when `payroll_cycle.status IN (…)`                                                                                                                  | Owner                                       |
| --- | ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | `INPUTS_UPLOADED`      | Accounts uploads payroll data      | `INPUTS_LOCKED, ATTENDANCE_SUBMITTED, ATTENDANCE_APPROVED, VALIDATING, VALIDATION_FAILED, VALIDATED, CALCULATING, CALCULATED, APPROVED, PUBLISHED, CLOSED` | Accounts                                    |
| 2   | `ATTENDANCE_SUBMITTED` | HR submits attendance              | `ATTENDANCE_SUBMITTED, ATTENDANCE_APPROVED, VALIDATING, VALIDATION_FAILED, VALIDATED, CALCULATING, CALCULATED, APPROVED, PUBLISHED, CLOSED`                | HR                                          |
| 3   | `ATTENDANCE_APPROVED`  | Managers approve attendance        | `ATTENDANCE_APPROVED, VALIDATING, VALIDATION_FAILED, VALIDATED, CALCULATING, CALCULATED, APPROVED, PUBLISHED, CLOSED`                                      | Manager                                     |
| 4   | `VALIDATED`            | System validates payroll inputs    | `VALIDATED, CALCULATING, CALCULATED, APPROVED, PUBLISHED, CLOSED`                                                                                          | System                                      |
| 5   | `CALCULATED`           | Payroll and payslips generated     | `CALCULATED, APPROVED, PUBLISHED, CLOSED`                                                                                                                  | System                                      |
| 6   | `APPROVED`             | Second Accounts approver signs off | `APPROVED, PUBLISHED, CLOSED`                                                                                                                              | Accounts (a different user from #5's actor) |
| 7   | `PUBLISHED`            | Payslips visible to employees      | `PUBLISHED, CLOSED`                                                                                                                                        | Accounts (a different user from #5's actor) |

`state` resolution, in this order, so it is total and has no undefined case:

1. the stage's `DONE` list contains `status` ⇒ `DONE`;
2. else `status = 'CANCELLED'` ⇒ every non-`DONE` stage is `PENDING` and the tracker carries
   `cycleCancelled: true` with `cancelReason`;
3. else `status = 'VALIDATION_FAILED'` and this is stage 4 ⇒ `BLOCKED`, `blockedReason` from
   the highest-severity unresolved `payroll_validation_result`;
4. else this is the lowest-numbered non-`DONE` stage ⇒ `CURRENT`, and `BLOCKED` instead when
   any guard of its transition is unsatisfied (`blockedReason` = that guard's message);
5. else `PENDING`.

`VALIDATING` and `CALCULATING` are _in-flight_ statuses: stage 4 / stage 5 is `CURRENT` with
`blockedReason: null` and `isRunning: true`, which is what drives the spinner. The
`stepTracker` labels are `ui_copy` keys `payroll.stage.<key>` and CI asserts the key set
equals the seven `state_transition` stages, so a renamed stage cannot drift.

This tracker is **back-office only**. The employee-facing projection of the same status is
the coarse `stageKey` of §1.6, which collapses `VALIDATING`, `VALIDATION_FAILED` and
`CALCULATING` to `IN_PROGRESS`.

#### `GET /payroll/cycles`

**P** `payroll:cycle:read` · **page/limit**, sort `period_start DESC`
`query: status z.enum(ess_payroll_cycle_status).optional(), fiscalYearId uuid optional`
`{ "data": [ PayrollCycleDto ], "page": {…} }` · empty ⇒ `emptyState.code = "PAYROLL_NO_CYCLES"`.

#### `POST /payroll/cycles`

**P** `payroll:cycle:create` · **I** yes · **RL** `user` 10/h

```
body: periodCode z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)   // 2026-08
      scheduledPayDate z.string().date().optional()            // default from organization.payroll_pay_day_rule
```

Creates the cycle **and** its 1:1 `attendance_period` (`label`, `start_date`, `end_date`,
`total_calendar_days` derived from `periodCode` in `organization.timezone`).
Guards `payroll.no_open_cycle_for_period`, `payroll.prior_cycle_closed`,
`payroll.dual_control_available` — the organisation must hold **at least two distinct,
`ACTIVE`, MFA-enrolled `app_user` rows with the ACCOUNTS persona** (the exact query is in
`DATA-MODEL.md` §3.3). Below two, the cycle cannot be created at all:
`409 DUAL_CONTROL_UNAVAILABLE` with `details.currentDistinctUsers`. Refusing at creation is
deliberate — refusing later, at `approve`, would leave a calculated cycle stranded and invite
someone to "temporarily" grant ACCOUNTS to a second account of the same human.
**`201`** `PayrollCycleDto` (status `DRAFT`).
Errors: `409 GUARD_FAILED` · `409 DUAL_CONTROL_UNAVAILABLE` · `409 DUPLICATE_RESOURCE` (`constraint="payroll_cycle_period"`).

#### `POST /payroll/cycles/:id/open-inputs`

**P** `payroll:cycle:transition` · **I** yes · **If-Match**
`DRAFT → INPUTS_OPEN`, guard `payroll.attendance_period_open`. Notifies HR.
**`200`** `PayrollCycleDto`.

#### `POST /payroll/cycles/:id/input-batches`

**P** `payroll:input:upload` · **I** yes · **RL** `user` 10/h

```
body: fileId z.string().uuid()                  // CLEAN file_object, purpose PAYROLL_INPUT_UPLOAD
      declaredTotalMinor z.number().int().min(0).optional()   // the uploader's control total
      note z.string().max(500).optional()
```

Parses in a worker, creates `payroll_input_batch` (status `PARSED` or `PARSE_FAILED`) and one
`payroll_input_item` per row with `source_row_no` — the traceability link back to the exact
line of the uploaded file. Money on every item is envelope-encrypted; `parsed_total_minor` is
computed at parse.

**`201 Created`**

```jsonc
{ "batch": { "id", "batchNo": 1, "status": ChipDto, "originalFilename": "aug-inputs.csv",
             "fileSha256": "…", "rowCountTotal": 87, "rowCountValid": 85, "rowCountRejected": 2,
             "declaredTotalMinor": 41220000, "parsedTotalMinor": 41220000,
             "uploadedAt": "…", "version": 1 },
  "rejections": [ { "rowNo": 12, "employeeNumber": "WDT-01922", "kind": "INCENTIVE",
                    "reason": "PAY_INPUT_ORPHAN_EMPLOYEE",
                    "message": "No active employee with this number in this period" } ],
  "parseErrors": [ { "line": 42, "column": "amount", "message": "Not an integer" } ] }
```

Errors: `422 FILE_NOT_CLEAN` · `422 CONTROL_TOTAL_MISMATCH` ·
`409 DUPLICATE_RESOURCE` (`constraint="payroll_input_batch_file_sha"` — the same file twice)
· `409 GUARD_FAILED` (cycle not `INPUTS_OPEN`) · `413 PAYLOAD_TOO_LARGE`.

#### `GET /payroll/cycles/:id/input-batches`

**P** `payroll:input:read` · **page/limit** · batch summaries incl. `declaredTotalMinor` vs `parsedTotalMinor`.

#### `GET /payroll/cycles/:id/input-batches/:batchId/items`

**P** `payroll:input:read` · **cursor**, sort `source_row_no`
`query: isRejected bool optional, kind enum optional, employeeId uuid optional`
Item: `{ id, sourceRowNo, employee: PersonRefDto, kind, payComponent: {id, code, name},
amount: MoneyDto|null, lopDaysOverride, effectivePeriodCode, narration,
expenseClaimId, isRejected, rejectionReason }`. `amount` is decrypted here (Accounts holds
`payroll:input:read`); every such read is a `READ_SENSITIVE` audit event.

#### `POST /payroll/cycles/:id/input-batches/:batchId/commit`

**P** `payroll:input:commit` · **I** yes · **If-Match**
`PARSED|VALIDATED → COMMITTED`. Requires `declared_total_minor IS NULL OR = parsed_total_minor`
(`ck_pib__totals_match`). **`200`** the batch.
`422 CONTROL_TOTAL_MISMATCH` · `409 STATE_TRANSITION_NOT_ALLOWED`.

#### `DELETE /payroll/cycles/:id/input-batches/:batchId`

**P** `payroll:input:commit` · marks `DISCARDED` (never a hard delete — the file stays as
evidence). **`200`** the batch. `409 CONFLICT` when already `COMMITTED`.

#### `POST /payroll/cycles/:id/lock-inputs`

**P** `payroll:input:commit` · **I** yes · **If-Match**
`INPUTS_OPEN → INPUTS_LOCKED`. Guards `payroll.at_least_one_committed_batch`,
`payroll.no_uncommitted_batches`, `payroll.all_batches_validated`.
**This is step 1 of the mandated order completing**; it is what unblocks HR's attendance
submit. Notifies HR (`PAYROLL_CYCLE_STATE`).
**`200`** `PayrollCycleDto`. `409 GUARD_FAILED` naming which batch is uncommitted.

#### `POST /payroll/cycles/:id/validate`

**P** `payroll:validate` · **I** yes · **If-Match**
`ATTENDANCE_APPROVED → VALIDATING`, guard `payroll.attendance_locked`
(`attendance_period.status IN ('APPROVED','LOCKED')`). **Refuses with
`409 GUARD_FAILED` while attendance is anything earlier** — including while managers are
still deciding. Runs the rule set of `DATA-MODEL.md` §10.6 synchronously (or `202` with a
`validationPassNo` for large orgs), writing `payroll_validation_result` rows, then the system
moves to `VALIDATED` (`payroll.no_error_validations`) or `VALIDATION_FAILED`.

**`200`**

```jsonc
{ "cycle": PayrollCycleDto, "validationPassNo": 3,
  "summary": { "error": 0, "warning": 4, "info": 12 } }
```

#### `GET /payroll/cycles/:id/validation-results`

**P** `payroll:cycle:read` · **cursor**, sort `severity DESC, created_at`
`query: passNo z.coerce.number().int().optional() (default latest), severity, unresolvedOnly bool`
`{ "id", "ruleCode": "PAY_BANK_UNVERIFIED", "severity": "WARNING",
  "employee": PersonRefDto|null, "entityType", "entityId", "message", "detail",
  "resolvedAt", "resolutionNote" }`
`message` and `detail` are **redacted** — no plaintext amounts (`DATA-MODEL.md` §10.6).

#### `POST /payroll/cycles/:id/validation-results/:resultId/resolve`

**P** `payroll:validate` · `body: { note z.string().trim().min(10).max(500) }` · * *
P * *

`p
a
y
r
o
l
l
:
v
a
l
i
d
a
t
e`

·

`
b
o
d
y
:

{

n
o
t
e

z
.
s
t
r
i
n
g
(
)
.
t
r
i
m
(
)
.
m
i
n
(
1
0
)
.
m
a
x
(
5
0
0
)
,

a
c
c
e
p
t
R
i
s
k

z
.
b
o
o
l
e
a
n
(
)
.
d
e
f
a
u
l
t
(
f
a
l
s
e
)

}
`

·

-
-

I * *

y
e
s

·

-
-

I
f
-

M
a
t
c
h * *

o
n

t
h
e

c
y
c
l
e

-
-

`2
0
0` * *

t
h
e

r
e
s
u
l
t

w
i
t
h

`r
e
s
o
l
v
e
d
A
t`
,

`r
e
s
o
l
v
e
d
B
y
U
s
e
r
I
d`

a
n
d

`r
e
s
o
l
u
t
i
o
n
N
o
t
e`
.

-
-

R
e
s
o
l
v
i
n
g

a
n

E
R
R
O
R

i
s

a

s
e
c
o
n
d

s
i
g
n
a
t
u
r
e
,

n
o
t

a

d
i
s
m
i
s
s
a
l
. * *

A

`W
A
R
N
I
N
G`

o
r

`I
N
F
O`

r
e
s
u
l
t

i
s

r
e
s
o
l
v
e
d

b
y

a
n
y

`p
a
y
r
o
l
l
:
v
a
l
i
d
a
t
e`

h
o
l
d
e
r

w
i
t
h

a

n
o
t
e
.

A
n

`E
R
R
O
R`

r
e
s
u
l
t

i
s

d
i
f
f
e
r
e
n
t
:

i
t

i
s

t
h
e

o
n
l
y

t
h
i
n
g

s
t
a
n
d
i
n
g

b
e
t
w
e
e
n

a

w
r
o
n
g

i
n
p
u
t

a
n
d

a

p
u
b
l
i
s
h
e
d

p
a
y
s
l
i
p
,

s
o

-

r
e
s
o
l
v
i
n
g

a
n

`E
R
R
O
R`

r
e
q
u
i
r
e
s

`
a
c
c
e
p
t
R
i
s
k
:

t
r
u
e
`

-
-

a
n
d * *

`p
a
y
r
o
l
l
:
a
p
p
r
o
v
e`

(
n
o
t

m
e
r
e
l
y

`p
a
y
r
o
l
l
:
v
a
l
i
d
a
t
e`
)
,

-
-

a
n
d * *

t
h
e

r
e
s
o
l
v
e
r

m
u
s
t

n
o
t

b
e

t
h
e

u
s
e
r

w
h
o

u
p
l
o
a
d
e
d

t
h
e

b
a
t
c
h

t
h
e

r
e
s
u
l
t

p
o
i
n
t
s

a
t

(
`p
a
y
r
o
l
l
_
i
n
p
u
t
_
b
a
t
c
h
.
u
p
l
o
a
d
e
d
_
b
y
_
u
s
e
r
_
i
d`
)

⇒

o
t
h
e
r
w
i
s
e

`
4
0
9

S
E
G
R
E
G
A
T
I
O
N
_
R
E
Q
U
I
R
E
D
`

w
i
t
h

`
d
e
t
a
i
l
s
.
r
e
q
u
i
r
e
s

=

"
a

s
e
c
o
n
d

A
c
c
o
u
n
t
s

a
p
p
r
o
v
e
r
"
`
;

-

a

r
u
l
e

w
h
o
s
e

`r
u
l
e
_
c
o
d
e`

i
s

i
n

t
h
e

-
-

n
o
n
-

o
v
e
r
r
i
d
a
b
l
e

s
e
t * *

c
a
n
n
o
t

b
e

r
e
s
o
l
v
e
d

a
t

a
l
l
,

o
n
l
y

f
i
x
e
d

a
t

s
o
u
r
c
e
:

`P
A
Y
_
N
E
G
A
T
I
V
E
_
N
E
T`
,

`P
A
Y
_
G
R
O
S
S
_
M
I
S
M
A
T
C
H`
,

`P
A
Y
_
C
O
N
T
R
O
L
_
T
O
T
A
L
_
M
I
S
M
A
T
C
H`
,

`P
A
Y
_
D
U
P
L
I
C
A
T
E
_
P
A
Y
S
L
I
P`
,

`P
A
Y
_
A
T
T
E
N
D
A
N
C
E
_
M
I
S
S
I
N
G`
,

`P
A
Y
_
A
T
T
E
N
D
A
N
C
E
_
N
O
T
_
A
P
P
R
O
V
E
D`
,

`P
A
Y
_
O
R
P
H
A
N
_
I
N
P
U
T
_
E
M
P
L
O
Y
E
E`
,

`P
A
Y
_
S
A
L
A
R
Y
_
S
T
R
U
C
T
U
R
E
_
M
I
S
S
I
N
G`
.

A
t
t
e
m
p
t
i
n
g

i
t

i
s

`
4
0
9

G
U
A
R
D
_
F
A
I
L
E
D
`

(
`
g
u
a
r
d
K
e
y
=

"
p
a
y
r
o
l
l
.
r
u
l
e
_
n
o
t
_
o
v
e
r
r
i
d
a
b
l
e
"
`
,

`d
e
t
a
i
l
s
.
r
u
l
e
C
o
d
e`
)
;

-

e
v
e
r
y

`E
R
R
O
R`

r
e
s
o
l
u
t
i
o
n

i
s

a

`P
A
Y
R
O
L
L
.
V
A
L
I
D
A
T
I
O
N
_
O
V
E
R
R
I
D
D
E
N`

a
u
d
i
t

e
v
e
n
t

a
t

`C
R
I
T
I
C
A
L`

s
e
v
e
r
i
t
y
,

a
p
p
e
a
r
s

o
n

t
h
e

c
y
c
l
e

a
s

`o
v
e
r
r
i
d
d
e
n
E
r
r
o
r
C
o
u
n
t`
,

a
n
d

i
s

r
e
p
r
o
d
u
c
e
d

v
e
r
b
a
t
i
m

o
n

t
h
e

`a
p
p
r
o
v
e`

s
c
r
e
e
n

s
o

t
h
e

s
e
c
o
n
d

a
p
p
r
o
v
e
r

s
i
g
n
s

w
i
t
h

t
h
e

o
v
e
r
r
i
d
e
s

i
n

f
r
o
n
t

o
f

t
h
e
m
.

T
h
e

c
o
u
n
t

i
s

a
l
s
o

a

c
o
l
u
m
n

o
n

`p
a
y
r
o
l
l
_
r
u
n`
,

s
o

a

p
u
b
l
i
s
h
e
d

c
y
c
l
e

p
e
r
m
a
n
e
n
t
l
y

r
e
c
o
r
d
s

h
o
w

m
a
n
y

e
r
r
o
r
s

w
e
r
e

w
a
v
e
d

t
h
r
o
u
g
h

a
n
d

b
y

w
h
o
m
.

A
n

`E
R
R
O
R`

t
h
a
t

i
s

r
e
s
o
l
v
e
d

u
n
d
e
r

t
h
e
s
e

c
o
n
d
i
t
i
o
n
s

n
o

l
o
n
g
e
r

b
l
o
c
k
s

#### `POST /payroll/cycles/:id/calculate`

**P** `payroll:calculate` · **I** yes · **If-Match** · **RL** `user` 10/h
`VALIDATED → CALCULATING`, guard `payroll.validated_recently` (validation ≤ 24 h old **and**
no `payroll_input_item` or `attendance_record` in scope changed since).
Creates `payroll_run` (`engine_version`, `ruleset_sha256`, `input_manifest_sha256` over every
consumed input id) and, on success, one `payslip` + its `payslip_line` rows per employee, each
with `attendance_record_id`, `salary_structure_id`, `salary_structure_sha256`,
`input_snapshot` and `input_sha256`. The system then moves to `CALCULATED` under
`payroll.run_succeeded` + `payroll.payslip_count_matches_employee_count` +
`payroll.controls_balance`.

**`202 Accepted`** `{ "cycle": PayrollCycleDto, "runId": "…", "runNo": 2, "status": "RUNNING" }`
Poll `GET /payroll/runs/:runId`.
Errors: `409 GUARD_FAILED` (`payroll.validated_recently` with `details.staleSince`) ·
`409 STATE_TRANSITION_NOT_ALLOWED`.

#### `GET /payroll/runs/:runId`

**P** `payroll:cycle:read` · `{ id, runNo, status, engineVersion, rulesetSha256,
inputManifestSha256, startedAt, finishedAt, employeeCount, payslipCount, errorMessage }`.
`errorMessage` is a safe summary; the detail is in the log under `requestId`.

#### `GET /payroll/cycles/:id/payslips`

**P** `payslip:read:any` (Accounts) · **cursor**, sort `employee.employee_number`
The payslip register: `{ employee: PersonRefDto, employeeNumber, payableDays, totalDays,
gross: MoneyDto, deductions: MoneyDto, net: MoneyDto, referenceNo, status }` with the
cycle control totals in a sibling `controlTotals` object. Every read is `READ_SENSITIVE`.

#### `POST /payroll/cycles/:id/approve`

**P** `payroll:approve` · **I** yes · **S** **yes** · **If-Match**
`body: { note z.string().trim().max(500).optional() }`
`CALCULATED → APPROVED`, guards `payroll.distinct_approver` + `payroll.controls_balance` +
`payroll.no_unresolved_errors`.

**`payroll.distinct_approver` is two comparisons, not one**, and each endpoint states which
it enforces (`DATA-MODEL.md` §10.1–10.2):

| Endpoint                                | Assertion                                                                                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST …/approve`                        | `actor.userId <> payroll_cycle.calculated_by_user_id`                                                                                                                                                                               |
| `POST …/publish`                        | `actor.userId <> payroll_cycle.calculated_by_user_id` **and** `actor.userId <> payroll_cycle.approved_by_user_id` is **not** required — the approver may publish what they approved; what is forbidden is the calculator publishing |
| `POST /payroll/corrections/:id/approve` | `actor.userId <> payroll_correction.raised_by_user_id`                                                                                                                                                                              |

Both are DB `CHECK`s as well as guards, so a handler bug cannot bypass them. Publishing is
additionally **step-up** gated, so a stolen session cannot complete the chain even if it
somehow held both ids.
**`200`** `PayrollCycleDto`.
`409 SEGREGATION_REQUIRED` with `details.requires = "a second Accounts approver"` when the
actor is `calculated_by_user_id` — also a DB `CHECK`, so it cannot be bypassed by a bug.

#### `POST /payroll/cycles/:id/publish`

**P** `payroll:publish` · **I** yes · **S** **yes** · **If-Match** · **RL** `user` 10/h
`body: { actualPayDate z.string().date() }`
`APPROVED → PUBLISHED`, guards `payroll.distinct_approver`,
`payroll.every_payslip_generated`, `payroll.pay_date_set`.
In one transaction: every payslip `GENERATED → PUBLISHED`; one `payslip_publication` per
payslip; one `PAYSLIP_PUBLISHED` `notification` per employee; one `email_outbox` row per
`payslip_fy_rollup` refreshed by `fn_refresh_payslip_fy_rollup(employee, fiscal_year)` —
which reads **only live publications**, so a later revocation reverses the YTD tiles rather
than leaving a stale total on screen; `tds_quarter` recomputed from the same predicate;
every `reimbursement_batch` that was `SENT_TO_PAYROLL` into this cycle moves to `PAID`, each
of its `expense_claim`s to `REIMBURSED` with `paid_in_payroll_cycle_id` set, and one
`EXPENSE_REIMBURSED` notification per claimant is queued;
`payroll_cycle.actual_pay_date` set.
**This is the only moment a payslip becomes visible to an employee.**
**`200`** `{ "cycle": PayrollCycleDto, "publishedPayslipCount": 214, "notificationsQueued": 214, "emailsQueued": 214 }`.
`409 SEGREGATION_REQUIRED` · `409 GUARD_FAILED` · `403 MFA_STEP_UP_REQUIRED`.

#### `POST /payroll/cycles/:id/close`

**P** `payroll:close` · **I** yes · `PUBLISHED → CLOSED`, guards `payroll.pay_date_passed`,
`payroll.reimbursements_settled`. **`200`** `PayrollCycleDto`.

#### `POST /payroll/cycles/:id/cancel`

**P** `payroll:cycle:transition` · **I** yes · `body: { reason (min 10) }`
Allowed only from `DRAFT|INPUTS_OPEN|INPUTS_LOCKED|VALIDATION_FAILED`, guard
`payroll.no_payslips_exist`. **There is no transition out of `PUBLISHED`** — a correction is
a new cycle or an off-cycle superseding revision.

#### `POST /payroll/corrections`

**P** `payroll:correction:raise` · **I** yes · **S** yes · **RL** `user` 10/h

```
body .strict():
  payrollCycleId  z.string().uuid()          // the PUBLISHED cycle being corrected
  employeeIds     z.array(z.string().uuid()).min(1).max(500)
  reason          z.string().trim().min(20).max(2000)
  correctionKind  z.enum(['WRONG_INPUT','MISSING_INPUT','ATTENDANCE_RESTATED','STATUTORY_RESTATED'])
```

This is the **only** way a published figure is ever changed. `POST /payroll/cycles/:id/cancel`
refuses from `PUBLISHED`, and `payslip` is immutable except `status`, `pdf_file_object_id`,
`supersedes_payslip_id` and `revoked_*` (`trg_payslip_immutable`), so without this endpoint
the system has a published wrong number and no lawful path to fix it — which is what forces
people to edit rows by hand. Creates a `payroll_correction` in `PENDING_APPROVAL` and an
`approval_task` for a **second** Accounts user. **`201`** the correction.
Errors: `409 GUARD_FAILED` (`guardKey="payroll.cycle_published"`) ·
`409 DUAL_CONTROL_UNAVAILABLE`.

#### `POST /payroll/corrections/:id/approve` · `…/reject`

**P** `payroll:correction:approve` · **I** yes · **S** yes · **If-Match**
`body: { note z.string().trim().min(10).max(500) }` (required on reject)
`payroll.distinct_approver` — the approver is not the raiser. On approve the system opens a
**correction run** against the same cycle (`payroll_run.run_kind = 'CORRECTION'`), which on
success produces, per affected employee, a new `payslip` with
`revision = prior.revision + 1` and `supersedes_payslip_id = prior.id`, sets the prior
payslip `SUPERSEDED`, sets the prior `payslip_publication.revoked_at` with the correction's
reason, publishes the new one, and queues a `PAYSLIP_CORRECTED` notification and email to the
employee. The net delta is written as a `payroll_input_item` of kind `ARREAR_ADJUSTMENT` into
the next `INPUTS_OPEN` cycle — never paid outside payroll.
**`200`** `{ correction, runId, affectedEmployeeCount }`.

#### `GET /payroll/corrections` · `GET /payroll/corrections/:id`

**P** `payroll:correction:read` · **page/limit**, sort `raised_at DESC`
`{ id, correctionNo, cycle: { id, label }, status: ChipDto, correctionKind, reason,
raisedAt, raisedBy: PersonRefDto, decidedAt, decidedBy: PersonRefDto, affectedEmployeeCount,
runId, version }`. Empty ⇒ `emptyState.code = "PAYROLL_NO_CORRECTIONS"`.

#### `POST /payroll/publications/:payslipId/revoke`

**P** `payroll:correction:raise` · **I** yes · **S** **yes** · **If-Match** on the payslip's
publication · **RL** `user` 10/h
`body: { reason z.string().trim().min(20).max(2000) }`

Withdraws visibility of a single published payslip **without** producing a replacement — used
when a payslip was published to the wrong employee or against a cancelled employment. Sets
`payslip_publication.revoked_at`, `revoked_by_user_id`, `revocation_reason`; sets
`payslip.status = 'REVOKED'`; calls `fn_refresh_payslip_fy_rollup` and the `tds_quarter`
recompute so the YTD tiles and quarterly TDS fall back in the same transaction; queues a
`PAYSLIP_REVOKED` notification. The employee's `GET /me/payslips` then returns that payslip's
absence with `emptyState.code = "PAYSLIPS_REVOKED"` when it was the only one.
The row is **never deleted** and the PDF is **never** unlinked — the evidence stays.
Guard `payroll.revocation_has_correction_or_reason`; audited `CRITICAL`.
**`200`** `{ payslipId, status: "REVOKED", revokedAt }`.

#### `GET /payroll/salary-structures/:employeeId`

**P** `payroll:salary_structure:read:any` · **S** yes · **unpaged**
Effective-dated rows with decrypted component amounts. Every read `READ_SENSITIVE`,
rate-limited at 30/h with a CRITICAL alert on trip (`SECURITY.md` §9.1).

#### `PUT /payroll/salary-structures/:employeeId`

**P** `payroll:salary_structure:write` · **I** yes · **S** yes
Creates a **new effective-dated row** (never edits an existing one) with
`revision_reason` and `structure_sha256`. `409 CONFLICT` when the date range overlaps
(`ex_salary_structure__no_overlap`), `409 CONFLICT` (`reason="REFERENCED_BY_PAYSLIP"`) on any
attempt to modify a referenced structure.

### 13.7 Payslips (Employee) — `/api/v1/me/payslips`

#### `GET /me/payslips`

**P** `payslip:read:self` · scope SELF · **page/limit**, sort `period_end DESC` (only value) · **RL** read

`query: fiscalYearId uuid optional (default current), page, limit`

The query is **always** the visibility gate of `DATA-MODEL.md` §10.7 — a join to
`payslip_publication` with `p.status='PUBLISHED' AND pub.published_at <= now() AND
pub.revoked_at IS NULL`. **No other path exists in the employee API.**

**`200 OK`**

```jsonc
{ "data": [ PayslipSummaryDto ],
  "page": { "page": 1, "limit": 25, "total": 5, "totalPages": 1 },
  "fiscalYear": { "id": "…", "label": "FY 2026–27" },
  "bankLine": { "bankName": "HDFC Bank", "last4": "4412" },   // omitted when no primary account
  "ytd": [ MetricDto, MetricDto, MetricDto, MetricDto ] }
```

`ytd` is read from `payslip_fy_rollup` for (`:me`, `:fy`) — one indexed read, never a scan.
Its money columns are **envelope-encrypted** (`DATA-MODEL.md` class M1: a rollup is a
ready-made annual-compensation table and is protected exactly like a payslip), so the mapper
decrypts `gross_earned_minor_ct`, `net_credited_minor_ct`, `tds_minor_ct`,
`employee_pf_minor_ct` and `employer_pf_minor_ct` — one AES-GCM operation each, on one row.
The row itself is maintained only by `fn_refresh_payslip_fy_rollup`, which aggregates
**live publications only**; it is refreshed on publish, on revocation and on correction, so
a YTD tile can never outlive the payslips behind it:

| Metric `key`     | `value`                                                                                       | `subLabel`                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GROSS_EARNED`   | `gross_earned_minor_ct` (decrypted)                                                           | `first_period_label` + ' – ' + `last_period_label`, via `periodRange()` (§12.18) → `Apr – Aug 2026` |
| `NET_CREDITED`   | `net_credited_minor_ct` (decrypted)                                                           | `payslip_count + ' payslips'`                                                                       |
| `TDS_DEDUCTED`   | `tds_minor_ct` (decrypted)                                                                    | `ui_copy` `payslips.tds_sub` → "Reflected in Form 26AS"                                             |
| `PF_CONTRIBUTED` | _(computed)_ `employee_pf_minor_ct + employer_pf_minor_ct`, both decrypted, summed in the API | `ui_copy` → "Employee + employer"                                                                   |

**When nothing is published this endpoint returns `200` with `data: []`, `total: 0`, all four
metrics `value: null`, and an `emptyState`.** It never returns `404`, never an error, and
never a sample payslip. The `emptyState.code` is derived from the earliest in-scope
`payroll_cycle.status`:

| Condition                                        | `code`                       | `message` (from `ui_copy`, params persisted)                                               |
| ------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------ |
| A cycle exists, `status < 'PUBLISHED'`           | `PAYSLIPS_CYCLE_IN_PROGRESS` | "{periodLabel} payroll is being processed." `params: { periodLabel, cycleStatus }`         |
| No cycle covers the employee yet                 | `PAYSLIPS_NO_CYCLE_YET`      | "Your first payslip appears after your first full pay period." `params: { dateOfJoining }` |
| Cycles exist but all published ones were revoked | `PAYSLIPS_REVOKED`           | "Your payslips are temporarily unavailable. Payroll has been notified."                    |

#### `GET /me/payslips/:id`

**P** `payslip:read:self` · **unpaged** · returns `PayslipDetailDto`.
Sets `payslip_publication.first_viewed_at` on the first successful read — a
`UPDATE … SET first_viewed_at = now() WHERE payslip_id = $1 AND first_viewed_at IS NULL`,
issued **after** the response is serialised and outside the read transaction, so a write
failure never fails the read and the route stays safe to serve from a read replica for its
`SELECT`. It is the only `GET` in this contract with a write side effect, and it is
idempotent.
The API asserts Σ lines == the stored totals before responding; a mismatch is
`500 INTEGRITY_ASSERTION_FAILED` and a P1 page — never a silently corrected number.
`404 NOT_FOUND` for any payslip not passing the visibility gate, including one belonging to
this employee that is merely `GENERATED`.

#### `GET /me/payslips/:id/download`

**P** `payslip:download:self` · signed URL per §11. `409 CONFLICT`
(`reason="PDF_NOT_READY"`) when `pdf_file_object_id IS NULL`; the SPA disables the button
with "PDF is being generated".

#### `POST /me/payslips/:id/email`

**P** `payslip:email:self` · **I** yes · **RL** `user` 10/h
`body: {}` — **there is no recipient field.** The destination is always
`employee.work_email` from the database.
**`202 Accepted`** `{ "queued": true, "toAddressMasked": "p•••••@widedrop.com", "emailOutboxId": "…" }`
Enqueues `email_outbox` kind `PAYSLIP_COPY_REQUESTED`. `template_data` carries identifiers
and labels only — **never** a salary figure (`DATA-MODEL.md` §17.4). The PDF is attached only
when its `file_object.scan_status = 'CLEAN'`.

### 13.8 Tax — `/api/v1/me/tax`, `/api/v1/accounts/…`

#### `GET /me/tax/summary`

**P** `tax:quarter:read:self` + `tax:declaration:read:self` · **unpaged**
`query: fiscalYearId uuid optional (default current)`

```jsonc
{ "fiscalYear": { "id", "label": "FY 2026–27" },
  "panMasked": "AXYPR••••K",                 // employee_statutory_id.value_mask WHERE kind='PAN'; null ⇒ prompt copy
  "regime": { "code": "NEW", "name": "New regime", "label": "New regime · FY 2026–27",
              "isDefault": false, "cessRatePercent": 4 },
  "projection": {
    "projectedAnnualTax":   MoneyDto,        // employee_tax_projection.projected_annual_tax_minor
    "projectedGross":       MoneyDto,        // projected_gross_minor
    "standardDeduction":    MoneyDto,        // standard_deduction_minor
    "declaredDeductions":   MoneyDto,
    "taxableIncome":        MoneyDto,
    "tdsDeductedToDate":    MoneyDto,        // tds_deducted_to_date_minor
    "tdsRemaining":         MoneyDto,        // GENERATED greatest(annual - to_date, 0)
    "monthlyTds":           MoneyDto,        // monthly_tds_minor
    "nextMonthTdsEstimate": MoneyDto,        // next_month_tds_estimate_minor
    "remainingMonths": 7,                    // remaining_months
    "deductedPercent": 42,                   // computed: round(to_date*100.0/nullif(annual,0))
    "deductedRangeLabel": "Apr – Aug",       // fiscal_year.start_date → as_of_period_code
    "asOfPeriodCode": "2026-08",
    "computedAt": "…" },
  "projectionEmptyState": null }              // present iff projection is null
```

No `is_current` projection ⇒ `projection: null` and
`projectionEmptyState.code = "TAX_NO_PROJECTION"` ("Your first payroll of FY 2026–27 has not
run yet"). Every figure then renders `—`. **Nothing is estimated client-side.**

#### `GET /me/tax/quarters`

**P** `tax:quarter:read:self` · **unpaged** (exactly 4)
`{ "data": [ { "quarterNo": 1, "label": "Q1 · Apr – Jun 2026",
               "tdsDeducted": MoneyDto|null,     // NULL while UPCOMING — a persisted absence
               "status": ChipDto,                // FILED green / IN_PROGRESS amber / UPCOMING gray / REVISED blue
               "payslipCount": 3, "form24qAckNo": "…", "filedAt": "…" } ] }`
`tds_deducted_minor` is recomputed as Σ decrypted `payslip.tds_minor_ct` over payslips with a
**live** `payslip_publication` (published, not revoked) whose
`period_end` falls in the quarter, with `source_payslip_ids` retained for traceability. A
`null` amount renders `—`; it is never shown as `₹0`.

#### `GET /me/tax/form16`

**P** `tax:form16:read:self` · **page/limit**, sort `issued_at DESC`
`{ "data": [ { "id", "fiscalYearLabel": "FY 2025–26", "issuedAt": "2026-06-12",
               "fileName": "Form16_FY2025-26.pdf", "status": ChipDto,
               "includesPartA": true, "includesPartB": true, "isDigitallySigned": true,
               "revision": 1, "tracesAckNo": "…" } ], "page": {…},
   "cardSubLabel": "Part A and Part B · digitally signed" }`
Filtered to `status IN ('ISSUED','REVISED')`. `cardSubLabel` is composed from the three
booleans. Empty ⇒ `emptyState.code = "FORM16_NOT_ISSUED"` with
`params.expectedByDate` from `fiscal_year` ("Form 16 for FY 2025–26 is issued by 15 June").

#### `GET /me/tax/form16/:id/download` — signed URL per §11.

#### `GET /me/tax/declaration`

**P** `tax:declaration:read:self` · **unpaged**

```jsonc
{ "declaration": { "id", "formReference": "12BB", "status": ChipDto,
                   "regime": { "code": "NEW", "name": "New regime" },
                   "submittedAt": "2026-04-18T…", "proofSubmittedAt": null,
                   "verifiedAt": null, "rejectionReason": null,
                   "declaredTotal": MoneyDto, "verifiedTotal": null,
                   "items": [ { "id", "sectionCode": "80C", "subCategory": "ELSS",
                                "declaredAmount": MoneyDto, "verifiedAmount": null,
                                "proofStatus": "NOT_SUBMITTED", "reviewerNote": null,
                                "displayOrder": 0 } ],
                   "version": 1 },
  "window": { "declarationOpensOn": "2026-04-01", "declarationClosesOn": "2026-04-30",
              "proofOpensOn": "2026-12-01", "proofClosesOn": "2027-01-15",
              "isDeclarationOpen": false, "isProofOpen": false } }
```

`window` comes from `fiscal_year.declaration_window_*` / `proof_window_*`. `isDeclarationOpen`
is what disables "Update declaration"; the disabled tooltip states the persisted dates.
No declaration row ⇒ `declaration: null` + `emptyState.code = "TAX_NO_DECLARATION"`.

#### `PUT /me/tax/declaration`

**P** `tax:declaration:write:self` · **If-Match** when a row exists · **RL** write

```
body: taxRegimeId z.string().uuid()
      items z.array(z.object({
        sectionCode z.enum([...seeded section codes]),
        subCategory z.string().max(120).optional(),
        declaredAmountMinor z.number().int().min(0).max(100_000_000_00),
        proofFileId z.string().uuid().optional()
      })).max(60)
```

Saves as `DRAFT`. `declared_total_minor` is **recomputed server-side** as Σ items; a
client-supplied total is not accepted. Guard `tax.declaration_window_open` ⇒
`422 DECLARATION_WINDOW_CLOSED` with `details.opensOn/closesOn`.

#### `POST /me/tax/declaration/submit`

**P** `tax:declaration:write:self` · **I** yes · **If-Match**
`DRAFT → SUBMITTED`, guard `tax.declaration_window_open`. **`200`** the declaration with the
persisted `submittedAt`.

#### `POST /me/tax/declaration/proofs`

**P** `tax:declaration:write:self` · **If-Match** · guard `tax.proof_window_open`
`body: { itemId, proofFileId }` per call. `SUBMITTED → PROOF_SUBMITTED` once
`tax.all_items_have_proof`. `422 PROOF_WINDOW_CLOSED` · `422 FILE_NOT_CLEAN`.

#### `POST /accounts/tax/declarations/:id/verify`

**P** `tax:declaration:verify` · **I** yes · **S** yes
`body: { outcome z.enum(['VERIFY','REJECT']), items: [{ itemId, verifiedAmountMinor, proofStatus, reviewerNote }], note }`
`PROOF_SUBMITTED → VERIFIED|REJECTED`. Audited with before/after.

#### `POST /accounts/form16/:id/issue`

**P** `tax:form16:issue` · **I** yes · **S** yes
`body: { fileId, tracesAckNo, includesPartA, includesPartB, isDigitallySigned }`
`PENDING → ISSUED`; emits `FORM16_ISSUED` notification + email.

#### `POST /accounts/tds-quarters/:id/file`

**P** `tax:quarter:manage` · **I** yes
`body: { form24qAckNo z.string().max(64), filedAt }` → `IN_PROGRESS → FILED`.

### 13.9 Benefits — `/api/v1/me/benefits`, `/api/v1/me/dependents`

#### `GET /me/benefits`

**P** `benefit:read:self` · **unpaged**

```jsonc
{ "planYearLabel": "Plan year Apr 2026 – Mar 2027",     // benefit_plan_year.label
  "data": [ { "enrolmentId": "…", "planId": "…",
              "categoryLabel": "Health",                 // benefit_plan.category humanised
              "name": "Group health insurance",          // benefit_plan.name
              "coverageKind": "FIXED_SUM_INSURED",
              "coverageValue": { "amountMinor": 50000000, "currency": "INR" },
              "coverageMultiple": null, "coverageRatePercent": null,
              "coverageDisplayHint": "AMOUNT",           // AMOUNT|MULTIPLE_OF_CTC|MONTHLY_AMOUNT|PERCENT_OF_BASIC|NONE
              "meta": "Family floater · ICICI Lombard · Policy WDT-GMC-2026 · Covers you, Karthik and Aarav",
              "status": ChipDto,
              "action": { "kind": "DOWNLOAD_ECARD", "label": "Download e-card",
                          "isEnabled": false, "disabledReason": "E-cards are issued from 1 Oct" },
              "enrolmentWindow": { "opensOn": "2026-04-01", "closesOn": "2026-04-15", "isOpen": false } } ] }
```

`coverageValue` resolution (`DATA-MODEL.md` §20.8) — the one non-obvious case is
`MONTHLY_AMOUNT` with `employer_contribution_pay_component_id` set: the value is **the amount
of that component on the employee's latest published payslip** (`payslip_line.amount_minor`),
not a stored guess. If there is no published payslip yet, `coverageValue` is `null` and the
card shows `—` with `coverageEmptyState.code = "BENEFIT_AWAITING_PAYSLIP"`.
`meta` is composed from `provider_name`, `policy_reference` and the covered dependents'
names via `benefit_enrolment_dependent` → `dependent.full_name` (decrypted for the owner
**`action` is a closed enum**, resolved server-side from `benefit_plan.action_kind` and the
enrolment's own state. There is no free-form action and no client-side mapping:

| `action.kind`         | Rendered              | `isEnabled` when                                                                   | `disabledReason` (`ui_copy` `benefit.action_disabled.<kind>` + persisted params)                                                           |
| --------------------- | --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `DOWNLOAD_ECARD`      | "Download e-card"     | `benefit_enrolment.ecard_file_object_id IS NOT NULL` and its `scan_status='CLEAN'` | `params.ecardAvailableFrom` = `benefit_plan_year.ecard_available_from`                                                                     |
| `VIEW_PLAN_DOCUMENT`  | "View policy"         | `benefit_plan.document_file_object_id IS NOT NULL`                                 | — (button absent, not disabled)                                                                                                            |
| `CHANGE_CONTRIBUTION` | "Change contribution" | the contribution window is open (`benefit_plan_year.contribution_window_*`)        | `params.opensOn`/`closesOn`; the action opens `POST /me/tickets` with `ticketCategoryId` = the `BENEFITS` category and a prefilled subject |
| `ADD_DEPENDENT`       | "Add dependent"       | `benefit_plan_year.enrolment_window_*` is open                                     | `params.opensOn`/`closesOn`                                                                                                                |
| `NONE`                | nothing               | —                                                                                  | —                                                                                                                                          |

`disabledReason` is **never** a literal such as "E-cards are issued from 1 Oct": it is a
`ui_copy` template interpolated with the persisted window dates, so when the window moves the
sentence moves with it. A plan with no persisted date and no open window has
`isEnabled: false, disabledReason: null`, and the SPA disables the button with no caption
rather than inventing one.

Only `ENROLLED` enrolments appear;
none ⇒ `data: []` + `emptyState.code = "BENEFITS_NONE_ACTIVE"`.

#### `GET /me/benefits/enrolments/:id/ecard` — signed URL per §11 · `409 CONFLICT` (`reason="ECARD_NOT_ISSUED"`).

#### `POST /me/benefits/:planYearId/enrol`

**P** `benefit:enrol:self` · **I** yes · guard: inside `enrolment_window_*` else
`422 ENROLMENT_WINDOW_CLOSED` (`details.opensOn/closesOn`).
`body: { dependentIds: z.array(uuid).max(10), employeeContributionMinor: int optional }`

#### `GET /me/dependents`

**P** `dependent:read:self` · **page/limit**
`{ "data": [ { "id", "initials": "KR", "fullName": "Karthik Raghavan",  // decrypted for owner; initials-only otherwise
               "relationship": "SPOUSE", "relationshipLabel": "Spouse",
               "ageYears": 33,                 // dependent.age_years — refreshed nightly, no decrypt on read
               "coverLabel": "Health insurance · Nominee",  // plan names via benefit_enrolment_dependent + ' · Nominee' when a nominee row references it
               "isVerified": true } ], "page": {…} }`
Empty ⇒ `emptyState.code = "DEPENDENTS_NONE"` with `params` carrying the enrolment-window
dates, so the card explains _when_ one can be added.

#### `POST /me/dependents`

**P** `dependent:write:self` · **I** yes · guard: enrolment window open

```
body: fullName z.string().trim().min(2).max(120)
      relationship z.enum(ess_dependent_relationship)
      dateOfBirth z.string().date()            // must be <= today
      gender z.enum(ess_gender).default('UNDISCLOSED')
      proofFileId z.string().uuid().optional()
```

**`201`** the dependent (`ageYears` computed server-side from the stored DOB).
`422 ENROLMENT_WINDOW_CLOSED` · `409 DUPLICATE_RESOURCE`.

#### `PATCH /me/dependents/:id` · `DELETE /me/dependents/:id` (soft: `is_active = false`) — **If-Match**.

#### `GET /me/nominees` · `PUT /me/nominees`

**P** `dependent:read:self` / `dependent:write:self`
`{ "data": [ { "id", "benefitPlanId": "…"|null, "dependentId": "…"|null,
               "fullName": "Karthik Raghavan", "relationship": "Spouse",
               "sharePercent": 100.00 } ] }`
`PUT` replaces the set for one plan; the server asserts Σ `sharePercent = 100.00` per plan
⇒ `422 BUSINESS_RULE_VIOLATED` (`rule="NOMINEE_SHARE_NOT_100"`, `details.sum`).

### 13.10 Expenses — `/api/v1/me/expense-claims`, `/manager/…`, `/accounts/…`

#### `GET /expenses/categories`

**P** `org:read` (reference data) · **unpaged**
`{ "data": [ { "id", "code": "REMOTE_WORK", "name": "Remote work",
               "requiresReceipt": true, "receiptRequiredAbove": MoneyDto|null,
               "requiresFinanceApproval": true, "displayOrder": 2,
               "limits": [ { "basis": "PER_MONTH", "cap": MoneyDto, "isHardLimit": true,
                             "sourcePolicyVersionLabel": "v3.0" } ] } ] }`
Caps come from `expense_limit` resolved for the actor's employment type and job level, with
`source_policy_version_id` so the UI can say which policy version set the cap.

#### `GET /me/expense-claims`

**P** `expense:claim:read:self` · **cursor**, sort `spend_date DESC, created_at DESC`
`query: status, categoryId, fiscalYearId (default current), from/to, limit, cursor`

```jsonc
{ "data": [ ExpenseClaimDto ], "page": {…},
  "stats": [ MetricDto, MetricDto, MetricDto ] }
```

`stats` from `expense_fy_rollup` (`DATA-MODEL.md` §20.9) — three indexed reads:

| `key`               | `value`                        | `subLabel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AWAITING_APPROVAL` | `awaiting_amount_minor`        | `awaiting_count + ' claim(s) with ' + the **distinct approvers of those claims**, read from `expense_claim.manager_employee_id`— the snapshot taken at submit, **not** the employee's current primary manager (after a re-org the two differ, and naming the current manager would tell the employee their claim sits with someone who has never seen it). More than one distinct approver ⇒`'<n> approvers'`. `awaiting_count = 0` ⇒ the sub-label is **omitted**, not rendered with a name.                                                                                                                                              |
| `APPROVED_UNPAID`   | `approved_unpaid_amount_minor` | A date is shown **only for claims actually queued into a cycle**: `payroll_cycle.scheduled_pay_date` reached through `expense_claim.reimbursement_batch_id → reimbursement_batch.payroll_cycle_id`, for claims in `QUEUED_FOR_PAYMENT`. A claim that is merely `FINANCE_APPROVED` is in no batch and has no pay date, so its share renders with `ui_copy` `expenses.not_yet_queued` ("Not yet queued for payment") rather than promising a date the system has not committed to. Mixed states ⇒ the earliest committed `scheduled_pay_date` plus `'and <n> not yet queued'`. **No enum-ordering scan for "the next cycle" exists** (§1.5). |
| `REIMBURSED_FY`     | `reimbursed_amount_minor`      | `reimbursed_count + ' claims since ' + to_char(fiscal_year.start_date,'Mon')`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

No rollup row ⇒ all three `value: null` + `emptyState.code = "EXPENSES_NONE_IN_FY"`.

#### `POST /me/expense-claims`

**P** `expense:claim:create:self` · **I** yes · **RL** write

```
body .strict():
  title z.string().trim().min(3).max(200)
  expenseCategoryId z.string().uuid()
  spendDate z.string().date()                       // <= today (ck_ec__spend_not_future)
  lines z.array(z.object({
    description z.string().trim().min(3).max(500),
    merchantName z.string().trim().max(120).optional(),
    spendDate z.string().date(),
    amountMinor z.number().int().min(1).max(10_000_000_00),
    taxAmountMinor z.number().int().min(0).default(0),
    expenseCategoryId z.string().uuid().optional()   // defaults to the header category
  })).min(1).max(50)
  attachmentFileIds z.array(z.string().uuid()).max(5).default([])
  submit z.boolean().default(true)
```

`total_amount_minor` is **trigger-maintained** as Σ lines; a client total is not accepted.
On submit, guards `expense.has_lines`, `expense.receipt_if_required`,
`expense.within_hard_limits`, `expense.spend_within_claim_window`, `expense.manager_exists`;
then `SUBMITTED → PENDING_MANAGER` creates the `approval_task` and the
`EXPENSE_SUBMITTED` notification. `is_within_limit` and `limit_applied_minor` are evaluated
and **persisted per line** so the decision is reviewable later.

**`201`** `ExpenseClaimDto` — the toast shows the persisted `claimNo` (`EXP-2291`), which came
from `expense_claim_seq`, never a client-side increment.
Errors: `422 EXPENSE_LIMIT_EXCEEDED` (`capAmountMinor`, `basis`, `lineNo`) ·
`422 ATTACHMENT_REQUIRED` (`aboveAmountMinor`) · `422 CLAIM_WINDOW_CLOSED`
(`windowDays`, `spendDate`) · `422 MANAGER_NOT_RESOLVED` · `422 FILE_NOT_CLEAN`.

#### `GET /me/expense-claims/:id` · `POST /me/expense-claims/:id/submit` (from `DRAFT`) ·

#### `POST /me/expense-claims/:id/withdraw`

**I** yes · **If-Match** · guard `expense.not_yet_decided` ⇒ `409 GUARD_FAILED` once a
manager has acted.

#### `POST /me/expense-claims/:id/attachments` · `DELETE …/attachments/:attachmentId`

`body: { fileId }` — re-checks `CLEAN` + ownership. Blocked once `status <> 'DRAFT'` and the
claim has left `PENDING_MANAGER`.

#### `GET /manager/expense-claims` · `POST /manager/expense-claims/:id/decide`

**P** `expense:claim:read:team` / `expense:claim:approve:team` · scope REPORTING_CHAIN ·
**I** yes · **If-Match** · **RL** `user` 200/h

```
body: outcome z.enum(['APPROVE','REJECT'])
      approvedAmountMinor z.number().int().min(0).optional()   // partial approval; <= total
      note z.string().trim().min(10).max(500).optional()       // REQUIRED on REJECT
```

`PENDING_MANAGER → MANAGER_APPROVED|MANAGER_REJECTED`; the system then routes to
`PENDING_FINANCE` (`expense.category_requires_finance`) or straight to
`QUEUED_FOR_PAYMENT`. **`200`** `{ claim, approvalTask }`.

#### `GET /accounts/expense-claims` · `POST /accounts/expense-claims/:id/decide`

**P** `expense:claim:read:any` / `expense:claim:approve:finance` · **I** yes
`PENDING_FINANCE → FINANCE_APPROVED|FINANCE_REJECTED`.

#### `GET /accounts/reimbursement-batches` · `POST /accounts/reimbursement-batches`

**P** `expense:reimburse` · **I** yes
`body: { cutoffDate z.string().date() }` → `DRAFT` batch, `batch_no` from a sequence.

#### `POST /accounts/reimbursement-batches/:id/add` _(canonical; `…/items` is not routed)_

`body: { expenseClaimIds: z.array(uuid).min(1).max(500) }` — every claim must be
`FINANCE_APPROVED` (`reimb.all_claims_finance_approved`) else `409 GUARD_FAILED` listing the
offending claim numbers in `details.claimNos`.

#### `POST /accounts/reimbursement-batches/:id/lock` → `DRAFT → LOCKED`.

#### `POST /accounts/reimbursement-batches/:id/send-to-payroll`

**I** yes · `body: { payrollCycleId }` · guard `reimb.cycle_inputs_open`
(`payroll_cycle.status = 'INPUTS_OPEN'`). Creates one `payroll_input_item` of kind
`REIMBURSEMENT_PAYOUT` per item, linked back to its `expense_claim_id`.
`LOCKED → SENT_TO_PAYROLL`. **`200`** the batch with `payrollInputItemsCreated`.
When that cycle publishes, the system moves the batch to `PAID`, each claim to `REIMBURSED`
with `paid_in_payroll_cycle_id` set, and emits `EXPENSE_REIMBURSED` —
**"paid with September salary" is therefore a join, never a caption.**

### 13.11 Documents — `/api/v1/me/documents`, `/me/document-requests`

#### `GET /me/documents`

**P** `document:read:self` · **cursor**, sort `document_date DESC`
`{ "data": [ { "id", "title": "Salary revision letter — FY 2026–27",
               "categoryLabel": "Compensation",     // document_type.category_label
               "documentDate": "2026-04-01", "version": 1, "isSystemGenerated": true } ] }`
`archived_at IS NULL` only. Empty ⇒ `emptyState.code = "DOCUMENTS_NONE"`.

#### `GET /me/documents/:id/download` — signed URL per §11, `download_count += 1`.

#### `GET /documents/letter-templates`

**P** `org:read` (reference data) · **unpaged**
`{ "data": [ { "id", "code": "SALARY_CERTIFICATE", "name": "Salary certificate",
               "requiresAddressee": true, "slaWorkingDays": 1, "displayOrder": 1 } ] }`
The form's "issued within 1 working day" is `slaWorkingDays` of the **selected** template —
persisted, not a hardcoded caption.

#### `GET /me/document-requests`

**P** `document:request:read:self` · **page/limit**, sort `requested_at DESC`
`{ "data": [ { "id", "requestNo": "WDT-DOC-2026-00214",
               "templateName": "Salary certificate", "addressee": "HDFC Bank",
               "purposeLabel": "Addressed to HDFC Bank",   // computed: addressee ? 'Addressed to …' : 'General purpose'
               "requestedAt": "2026-09-18T…", "dueAt": "…", "status": ChipDto,
               "isDownloadable": true,                     // = employee_document_id IS NOT NULL
               "version": 1 } ], "page": {…} }`

#### `POST /me/document-requests`

**P** `document:request:create:self` · **I** yes

```
body: letterTemplateId z.string().uuid()
      addressee z.string().trim().max(200).optional()   // required when template.requires_addressee
      purposeNote z.string().trim().max(500).optional()
```

`due_at` = `requested_at + sla_working_days` **resolved against the holiday calendar**, not
naive arithmetic. **`201`** the request; the toast reads the persisted `requestNo` and
`slaWorkingDays`.
`422 VALIDATION_FAILED` when `requires_addressee` and none supplied.

#### `POST /me/document-requests/:id/cancel` — `SUBMITTED → CANCELLED`, guard `docreq.self_only`.

#### `GET /me/document-requests/:id/download` — signed URL; `404` while `employee_document_id IS NULL`.

#### `GET /hr/document-requests` — **P** `document:request:read:any` · **cursor** · the HR queue

(`ix_dr__queue`), filterable by `status`, `assigneeUserId`, overdue.

#### `POST /hr/document-requests/:id/issue`

**P** `document:request:fulfil` · **I** yes · **S** yes when
`letter_template.includes_salary_details`
`body: { employeeDocumentId | fileId, note }` · guard `docreq.document_attached`.
`PROCESSING → ISSUED`; emits `DOCUMENT_ISSUED` notification + email.

#### `POST /hr/document-requests/:id/reject` — `body: { reason (min 10) }`.

#### `POST /hr/employees/:employeeId/documents` — **P** `document:upload:any` · **I** yes ·

`body: { documentTypeId, title, fileId, documentDate, visibility }`.

### 13.12 Policies — `/api/v1/me/policies`, `/api/v1/hr/policies`

#### `GET /me/policies`

**P** `policy:read` · scope SELF (the actor's assignments) · **page/limit**, sort
`policy.display_order, policy.name`

```jsonc
{ "data": [ PolicyListItemDto ],
  "page": { "page": 1, "limit": 25, "total": 8, "totalPages": 1 },
  "pendingCount": 2 }
```

Rows come from `policy_assignment` where `superseded_at IS NULL`, joined to
`policy_version` and `policy`. `pendingCount` is the exact query of `DATA-MODEL.md` §20.6;
`0` ⇒ the SPA omits the chip entirely. No assignments ⇒ `data: []` +
`emptyState.code = "POLICIES_NONE_ASSIGNED"`.

#### `GET /me/policies/:versionId`

**P** `policy:read` · **unpaged** · returns `PolicyDetailDto`.
`404 NOT_FOUND` when the version is not `PUBLISHED`/`SUPERSEDED` or the actor has no
assignment and lacks a broader `policy:read` scope. `bodySha256` is returned so the client
echoes back exactly what it rendered.

#### `POST /me/policy-versions/:versionId/acknowledge` _(canonical; `/me/policies/:versionId/acknowledge` is not routed)_

**P** `policy:acknowledge:self` · **I** yes · **RL** `user` 30/h

```
body .strict():
  bodySha256 z.string().regex(/^[0-9a-f]{64}$/)   // must equal policy_version.body_sha256
  acknowledgementText z.string().trim().min(5).max(200)   // must equal ui_copy policy.ack_sentence
```

Guard `policy.assignment_open`. In one transaction: insert `policy_acknowledgement` with
`policy_assignment_id`, `policy_version_id`, `employee_id`, `status = 'ACKNOWLEDGED'`,
`acknowledged_at = now()`, `acknowledged_body_sha256` (**proof of what was acknowledged**),
`acknowledgement_text`, `ip_address`, `user_agent`, `app_user_id`; write the `audit_event` and
link `audit_event_id`. The table is **append-only** — an acknowledgement is never edited.

**Idempotency is doubly guaranteed:** the `Idempotency-Key` replay path, and
`ux_pack__assignment UNIQUE (policy_assignment_id)`. A second call with a **different**
`Idempotency-Key` but the same assignment returns **`200 OK`** with the _existing_
acknowledgement (not `409`) — re-clicking "I have read and acknowledge" must never look like
an error to the employee.

**`201 Created`** on first acknowledgement, **`200 OK`** on a repeat:

```jsonc
{
  "acknowledgementId": "…",
  "policyVersionId": "…",
  "status": "ACKNOWLEDGED",
  "acknowledgedAt": "2026-09-29T04:41:22.108Z", // the PERSISTED timestamp the UI renders
  "versionLabel": "v4.2",
  "bodySha256": "…",
}
```

Errors: `409 GUARD_FAILED` (`guardKey="policy.assignment_open"` — no live assignment, or the
version was superseded while the page was open; `details.currentVersionId` lets the SPA
reload) · `422 BUSINESS_RULE_VIOLATED` (`rule="BODY_HASH_MISMATCH"` — the client rendered a
stale body; it must reload before acknowledging) · `404 NOT_FOUND`.

#### `GET /me/policies/:versionId/download` — signed URL; the button is not rendered when

`pdfAvailable` is false.

#### `GET /hr/policies` · `POST /hr/policies`

**P** `policy:author` · `POST body: { name, ownerLabel, contactEmail, displayOrder }`.

#### `POST /hr/policies/:policyId/versions`

**P** `policy:author` · **I** yes

```
body: versionMajor z.number().int().min(0), versionMinor z.number().int().min(0)
      summary z.string().trim().min(20).max(2000)
      bodyMarkdown z.string().trim().min(50).max(200_000)   // see the body-size note below
      appliesToLabel z.string().trim().max(200)
      effectiveFrom z.string().date()
      nextReviewOn z.string().date().optional()
      requiresAcknowledgement z.boolean().default(true)
      acknowledgementDueDays z.number().int().min(1).max(365).optional()
      acknowledgementDueOn z.string().date().optional()      // exactly one of the two
      points z.array(z.string().trim().min(5).max(500)).max(20)
      applicabilityRules z.array(z.object({
        dimension z.enum(ess_policy_applicability_dimension),
        isInclude z.boolean().default(true),
        departmentId|locationId|designationId|costCentreId|employeeId uuid optional,
        employmentType enum optional,
        includesDepartmentDescendants z.boolean().default(true)
      })).min(1).max(50)
      pdfFileId z.string().uuid().optional()
```

Creates a `DRAFT` version; `body_sha256` is computed server-side over the **NFC-normalised,
LF-normalised** `bodyMarkdown` — the same normalisation the detail endpoint applies before
hashing, so a client that renders what it was sent can always echo a matching hash.

**Body-size exception.** The global request cap is 128 KiB (§2.3 `PAYLOAD_TOO_LARGE`), which
a 200 000-character policy body would exceed. This route — and only this route and
`PATCH /hr/policies/versions/:versionId` — declares `config.bodyLimitBytes: 1_048_576`
(1 MiB). Nothing else in the contract raises the cap. Over 1 MiB the author attaches a PDF
(`pdfFileId`) and keeps `bodyMarkdown` to the summary: a policy body nobody will read in a
browser is not a reason to widen the parser for every route.
**`201`** the version.

#### `PATCH /hr/policies/versions/:versionId` — **If-Match** — allowed **only** while `DRAFT`;

any attempt after that is `409 CONFLICT` (`reason="VERSION_IMMUTABLE"`), matching
`trg_policy_version_immutable`.

#### `POST /hr/policies/versions/:versionId/publish`

**P** `policy:publish` · **I** yes · **S** no · maker-checker ‡

`IN_REVIEW → PUBLISHED`, guards `policy.has_body` (and `body_sha256` still matches the text),
`policy.effective_date_set`, `policy.applicability_defined`. Runs the `policy-assignment` job
**synchronously inside the transaction**, materialising one `policy_assignment` per matching
active employee with its resolved `due_on`, superseding the prior version's open assignments,
and emitting one `POLICY_ASSIGNED` notification each.

**`200 OK`**

```jsonc
{ "version": { "id", "versionLabel": "v4.3", "status": "PUBLISHED", "publishedAt": "…" },
  "assignmentsCreated": 214, "assignmentsSuperseded": 198, "notificationsQueued": 214 }
```

The HR screen reports **the real number of employees assigned**, from the transaction.
Errors: `409 SEGREGATION_REQUIRED` (`requires = "a second HR approver"` — the publisher may
not be the version's author) · `409 GUARD_FAILED` · `409 STATE_TRANSITION_NOT_ALLOWED`.

#### `GET /hr/policies/versions/:versionId/compliance`

**P** `policy:ack:read:any` · **page/limit**
`{ "summary": { "assigned": 214, "acknowledged": 198, "pending": 12, "overdue": 4 },
   "data": [ { "employee": PersonRefDto, "status": ChipDto, "dueOn", "acknowledgedAt" } ] }`
The summary is the `GROUP BY` of `DATA-MODEL.md` §20.15, computed, not stored.

### 13.13 Announcements — `/api/v1/me/announcements`, `/api/v1/hr/announcements`

#### `GET /me/announcements`

**P** `announcement:read` · **cursor**, sort `is_pinned DESC, published_at DESC`
Predicate: `status='PUBLISHED' AND archived_at IS NULL AND (expires_at IS NULL OR expires_at > now())`
**AND the audience matches the actor** via `announcement_audience` (ALL / DEPARTMENT with
descendants / LOCATION / EMPLOYMENT_TYPE / EMPLOYEE). A non-targeted announcement is not
merely hidden in the UI — it is outside the query.

`{ "data": [ { "id", "title", "categoryLabel": "People Ops", "authorByline": "Ananya Bose · People Ops",
               "publishedAt": "2026-09-26T…", "isPinned": true, "isRead": false,
               "excerpt": "…first 180 chars of body_markdown, plain-text…" } ], "page": {…} }`
Empty ⇒ `emptyState.code = "ANNOUNCEMENTS_NONE"`.

#### `GET /me/announcements/:id`

Adds `bodyMarkdown` (rendered to paragraphs client-side with a strict sanitiser — the API
never sends HTML) and `attachment`. Reading does **not** implicitly mark as read.

#### `POST /me/announcements/:id/read`

**P** `announcement:read` · **I** not required (upsert) · **`204`**
Upserts `announcement_read` (`first_read_at`, `last_read_at`, `read_count += 1`).

#### `POST /hr/announcements` · `PATCH /hr/announcements/:id` (**If-Match**, `DRAFT` only) ·

#### `POST /hr/announcements/:id/publish`

**P** `announcement:author` / `announcement:publish` · **I** yes
`body: { publishAt z.string().datetime().optional() }` — future-dated ⇒ `SCHEDULED`, picked up
by the `announcement-publish` job. Publishing fans out one
`ANNOUNCEMENT_PUBLISHED` notification per employee **in the audience**, each inserted only
after `canSee()` passes (`SECURITY.md` §4.10).
**`200`** `{ announcement, notificationsQueued: 214 }`.

#### `POST /hr/announcements/:id/pin` · `/unpin` · `body: { pinnedUntil: date|null }`.

#### `POST /hr/announcements/:id/archive`.

### 13.14 Help desk — `/api/v1/me/tickets`, `/api/v1/hr/tickets`

#### `GET /help-desk/categories`

**P** `org:read` (reference data) · **unpaged**
`{ "data": [ { "id", "code": "PAYROLL_TAX", "name": "Payroll & tax",
               "firstResponseSlaHours": 8, "isAnonymousAllowed": false, "displayOrder": 0 } ],
   "firstResponseSlaLabel": "within 1 working day" }`
The header copy is derived from `min(first_response_sla_hours)` humanised against the
organisation's working hours — persisted, not a caption.

#### `GET /help-desk/faq`

**P** `org:read` (reference data) · **unpaged**, ordered by `display_order`
`{ "data": [ { "id", "question", "answerMarkdown", "categoryId" } ] }`
**No published rows ⇒ `data: []` and the SPA does not render the card at all**
(`DATA-MODEL.md` §16.6).

#### `GET /me/tickets`

**P** `ticket:read:self` · **cursor**, sort `created_at DESC`
`{ "data": [ TicketDto ], "page": {…} }` — `notificationEmailStatus` is **omitted** on this
employee-facing view. Empty ⇒ `emptyState.code = "TICKETS_NONE"`.

#### `POST /me/tickets`

**P** `ticket:create:self` · **I** yes · **RL** `user` 10/h

```
body .strict():
  ticketCategoryId z.string().uuid()
  subject     z.string().trim().min(5).max(200)
  description z.string().trim().max(5000).optional()
  priority    z.enum(['LOW','NORMAL','HIGH','URGENT']).default('NORMAL')
  isAnonymous z.boolean().default(false)        // permitted only when category.is_anonymous_allowed
  attachmentFileIds z.array(z.string().uuid()).max(3).default([])
  relatedEntity z.object({ type: z.enum(['payslip','employee_bank_account','form16_document',
                                          'expense_claim','leave_request','employee']),
                            id: z.string().uuid() }).optional()
```

**`relatedEntity` is authorised, not merely typed.** The pair is resolved through the same
`authzWhere` the owning module uses, for the actor, **before** the ticket is created. An id
the actor cannot read is `404 NOT_FOUND` — indistinguishable from "does not exist", so this
field cannot be used to probe for the existence of another employee's payslip or bank
account. Only these types are accepted, each with the permission it is resolved under:
`payslip` (`payslip:read:self`), `form16_document` (`tax:form16:read:self`),
`employee_bank_account` (`profile:read_sensitive:self`, own row only),
`expense_claim` (`expense:claim:read:self`), `leave_request` (`leave:request:read:self`),
`employee` (must equal `actor.employeeId`). The stored link is `(type, id)` only; **no
attribute of the related entity is copied into the ticket, the notification or the email.**

**`isAnonymous` is anonymous to HR, not to the audit chain.** When true: `raised_by_employee_id`
is still stored (an anonymous channel with no accountability is a harassment vector), but it
is projected as `null` on every `ticket:read:any` surface, excluded from `TicketDto.raisedBy`,
excluded from `template_data`, and `reply_to_address` is omitted. Only
`audit:read` holders can join the ticket to a person, and doing so is itself a
`READ_SENSITIVE` audit event. The HR queue renders `ui_copy` `ticket.anonymous_notice`
("Anonymous — reply in the portal thread; email reply is not available"), so an anonymous
ticket never looks unanswerable.

**One transaction, both effects (Directive 8):**

1. Insert `helpdesk_ticket` — `ticket_no` from `helpdesk_ticket_seq` (`HD-4821`),
   `first_response_due_at` = `created_at + first_response_sla_hours` **on the working-hours
   calendar**, `resolution_due_at` likewise.
2. Insert **one `email_outbox` row** with
   `kind = 'HELPDESK_TICKET_CREATED'`,
   `to_addresses = {ticket_category.routing_email}` — which defaults to
   `organization.helpdesk_email` = **`helpdesk@widedroptech.com`**,
   `from_address = no-reply@widedroptech.com`,
   `reply_to_address = employee.work_email` (omitted when `is_anonymous`),
   `subject = '[' || ticket_no || '] ' || category.name || ' — ' || subject`,
   `idempotency_key = 'HELPDESK_TICKET_CREATED:helpdesk_ticket:<id>:v1'`,
   `template_data = { ticketNo, categoryName, subject, raisedByName?, raisedAt, priority, portalUrl }`
   — identifiers and labels only, **no PII beyond the name, no amounts, no tokens**.
3. Set `helpdesk_ticket.email_outbox_id` to that row.
4. Insert a `TICKET_UPDATED` notification for the raiser and the `audit_event`.

**`201 Created`** · `Location: /api/v1/me/tickets/{id}`

```jsonc
{ "ticket": TicketDto,
  "slaHours": 8,
  "notification": { "emailQueued": true, "queuedTo": "helpdesk@widedroptech.com" } }
```

The toast renders the **persisted** `ticketNo` and the SLA from the category. It never
displays a guessed id.

Errors: `403 AUTHZ_DENIED` (anonymous requested on a category that forbids it) ·
`422 FILE_NOT_CLEAN` · `429 RATE_LIMITED`.

#### The outbox → worker contract, and what happens when the mail provider is down

| Property                                       | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Atomicity**                                  | The `email_outbox` row is inserted in the **same transaction** as the ticket. If the ticket insert rolls back, no email row exists. If it commits, the email is durably queued. There is no code path that sends mail outside this table.                                                                                                                                                                                                                                                                                           |
| **The ticket is never contingent on delivery** | `POST /me/tickets` returns `201` as soon as the transaction commits. Delivery is asynchronous and is **never** a precondition for the record (`DATA-MODEL.md` §17.4).                                                                                                                                                                                                                                                                                                                                                               |
| **Worker**                                     | `email-dispatch` runs every 15 s. Claim query: `SELECT … WHERE status IN ('QUEUED','SENDING') AND next_attempt_at <= now() ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 50` (index `ix_email_outbox__dispatch`), so multiple API instances never double-send.                                                                                                                                                                                                                                                              |
| **Idempotency at the provider**                | `ux_email_outbox__org_idempotency UNIQUE (organization_id, idempotency_key)` means a retried transaction cannot enqueue twice; the provider message id is stored on success (`provider_message_id`, required when `status='SENT'`).                                                                                                                                                                                                                                                                                                 |
| **Body handling**                              | `body_text`/`body_html` are rendered **at send time** from `template_code` + `template_data`, and are **nulled after `SENT`** so the outbox does not become a copy of everyone's correspondence.                                                                                                                                                                                                                                                                                                                                    |
| **Attachments**                                | Only `file_object`s with `scan_status = 'CLEAN'` are attached; anything else is dropped from the attachment list and noted in `last_error` without failing the send.                                                                                                                                                                                                                                                                                                                                                                |
| **Provider down**                              | The claim fails, `retry_count += 1`, `last_error` is set, `next_attempt_at = now() + 2^retry_count minutes` capped at 60 min, `status` stays `QUEUED`. **The ticket remains fully functional throughout** — it is in the HR queue, it can be assigned, commented on and resolved in the portal.                                                                                                                                                                                                                                     |
| **Exhaustion**                                 | After `max_retries` (5, ≈ 1 hour of backoff) the row becomes `FAILED` with `failed_at` and `last_error`. This is surfaced two ways: (a) `TicketDto.notificationEmailStatus = "FAILED"` on the **HR** view, which renders a banner _"The email notification to helpdesk@widedroptech.com could not be delivered — this ticket is still open and assigned"_; (b) a `SECURITY`/ops alert on the `email_outbox__failed` index count. The employee-facing view never shows this — it is an internal delivery concern, not their problem. |
| **Manual retry**                               | `POST /admin/email-outbox/:id/retry` (**P** `org:manage`, **I** yes) resets `status='QUEUED'`, `retry_count=0`, `next_attempt_at=now()`. Audited.                                                                                                                                                                                                                                                                                                                                                                                   |
| **Suppression**                                | A hard bounce sets `status='SUPPRESSED'`; the address is added to a suppression list so the worker stops retrying a dead mailbox.                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Never**                                      | The outbox never stores a password, a token, a signed URL, a salary figure or a bank detail in `template_data` — enforced by a Zod schema per `template_code`.                                                                                                                                                                                                                                                                                                                                                                      |

#### `GET /me/tickets/:id` — `TicketDto` + `comments[]` filtered to `visibility='PUBLIC'`

(**`INTERNAL` comments are excluded by the query and by RLS**, not hidden client-side).

#### `POST /me/tickets/:id/comments` — **I** yes · `body: { body z.string().trim().min(1).max(5000), attachmentFileIds }`

· `WAITING_ON_EMPLOYEE → IN_PROGRESS`.

#### `POST /me/tickets/:id/close` — **I** yes · `RESOLVED → CLOSED` · optional

`satisfactionRating z.number().int().min(1).max(5)`.

#### `POST /me/tickets/:id/reopen` — guard `ticket.within_reopen_window` (14 days) ⇒

`409 GUARD_FAILED` with `details.resolvedAt`.

#### `GET /hr/tickets` — **P** `ticket:read:any` · **cursor** · the queue (`ix_ht__queue`),

filters `status`, `categoryId`, `assigneeUserId`, `slaBreached`, `emailStatus`.

#### `POST /hr/tickets/:id/assign` — **I** yes · `body: { assigneeUserId }`.

#### `POST /hr/tickets/:id/comments` — `body: { body, visibility z.enum(['PUBLIC','INTERNAL']) }`.

#### `POST /hr/tickets/:id/resolve` — **I** yes · `body: { resolutionSummary (min 10) }` ·

guard `ticket.resolution_summary_present` · emits `TICKET_RESOLVED`.

### 13.15 Approvals (Manager) — `/api/v1/manager/approvals`

The unified queue. One table, one index, one count — the sidebar badge and this list are the
same query (`DATA-MODEL.md` §20.14).

#### `GET /manager/approvals`

**P** `approval:task:read:team` (scope DIRECT_REPORTS/REPORTING_CHAIN, resolved as
`assignee_employee_id = :me`) · **page/limit**,
sort `priority_order, requested_at` (only value)
`query: kind z.enum(['LEAVE_REQUEST','EXPENSE_CLAIM','ATTENDANCE_PERIOD','DOCUMENT_REQUEST']).optional()`

`{ "data": [ ApprovalTaskDto ], "page": { page, limit, total, totalPages },
   "directReportCount": 3 }`
`total` is the pending count — the same number as the sidebar badge and the tab label
"Pending · 3". `directReportCount` is the `employee_reporting_closure depth=1` count joined
to active employees — the header's "· 3 reports". Empty ⇒ `data: []`, `total: 0`, plus
`emptyState.code = "APPROVALS_ALL_CAUGHT_UP"` → exactly the prototype's "All caught up"
block.

#### `GET /manager/approvals/history`

**P** `approval:task:read:team` · **cursor**, sort `decided_at DESC`
`ApprovalTaskDto` with the `decision` object populated from `approval_decision`.
Empty ⇒ `emptyState.code = "APPROVALS_NO_HISTORY"`.

> **`approval:task:read:any` is not a Manager permission.** `DATA-MODEL.md` §3.3 grants
> MANAGER `approval:task:read:team` and `approval:task:act` only; `:any` is held by **HR**,
> for the escalation and audit surfaces (`GET /hr/approvals`, below). Under the RLS shape of
> `DATA-MODEL.md` §1.8.3 a Manager holding `:any` would be able to read **every** manager's
> queue org-wide — subject names, amounts and subtitles included — which is a privilege
> escalation, not a convenience. Both `/manager/approvals` routes therefore declare `:team`
> and additionally pin `assignee_employee_id = :me` in the query, so even an over-broad grant
> cannot widen the result set.

#### `GET /hr/approvals`

**P** `approval:task:read:any` · **cursor**, sort `due_at`, filters `kind`, `status`,
`assigneeEmployeeId`, `overdueOnly` · **HR only**
The org-wide queue view used for chasing overdue approvals and for the attendance escalation
screen. It returns `ApprovalTaskDto` **without** `amount` — HR holds no `expense:claim:read:*`
beyond team scope and must not learn claim values from a queue — and never exposes a decision
control; HR acts through `POST /hr/attendance/approvals/:id/escalate`, not by deciding on a
manager's behalf. Empty ⇒ `emptyState.code = "APPROVALS_NONE_ORG_WIDE"`.

#### `POST /manager/approvals/:id/decide`

**P** `approval:task:act` · **I** yes · **If-Match** · **RL** `user` 200/h + bulk-rubber-stamping signal

```
body: outcome z.enum(['APPROVE','REJECT','REASSIGN'])
      note z.string().trim().min(10).max(500).optional()   // REQUIRED for REJECT and REASSIGN
      approvedAmountMinor z.number().int().min(0).optional()  // EXPENSE_CLAIM partial approval
      reassignToEmployeeId z.string().uuid().optional()       // REQUIRED for REASSIGN
```

A **polymorphic** endpoint: it resolves the task's `kind`, then performs the underlying
entity's transition (`leave_request`, `expense_claim`, `attendance_approval`,
`document_request`) with that machine's own guards, in one transaction with the
`approval_decision` insert and the `audit_event`. It exists so the prototype's mixed queue
can be actioned without the client knowing which module a card belongs to; the per-module
endpoints (§13.4, §13.5, §13.10) remain available and behave identically.

Guards: `approval.actor_is_assigned_approver`, plus `approval.note_required` on
`REJECT`/`REASSIGN`, plus the entity's own guards.

**`REASSIGN` is bounded, not free.** `reassignToEmployeeId` must resolve to an `ACTIVE`
employee who (a) is not the actor, (b) is not the task's `subject_employee_id`
(`ck_at__not_self` is re-asserted on the new row), and (c) is either the actor's own primary
manager, or the subject's HR business partner, or a holder of the same approval permission
within the subject's `employee_reporting_closure`. Anything else is
`422 BUSINESS_RULE_VIOLATED` (`rule="REASSIGN_TARGET_INVALID"`). The original task is closed
with outcome `REASSIGNED` and a **new** `approval_task` is created for the target, so the
pending count, the badge and the queue remain one query; `approval_decision` records both
sides. Reassignment does **not** move the underlying entity's state machine.
`POST /manager/approvals/:id/decide` with `REASSIGN` is the only route that creates an
approval task from a client request, and it can only move one that already exists.

**`200 OK`** `{ "task": ApprovalTaskDto, "entity": <the module DTO>, "pendingCount": 2 }`
— `pendingCount` is re-read so the badge updates from the server, not from a client decrement.

Errors: `403 SELF_APPROVAL_FORBIDDEN` · `404 NOT_FOUND` (not assigned to the actor) ·
`409 STATE_TRANSITION_NOT_ALLOWED` (already decided — the SPA refetches) ·
`409 VERSION_CONFLICT` · `422 NOTE_REQUIRED` · `422 APPROVED_AMOUNT_EXCEEDS_CLAIM` ·
`422 BUSINESS_RULE_VIOLATED` (`rule="REASSIGN_TARGET_INVALID"`).

### 13.16 Notifications — `/api/v1/me/notifications`

Every row is traceable to a `state_transition` that declared `emits_notification_kind` or a
named job rule (`notification.source_rule_code`). **There is no endpoint that creates an
arbitrary notification.**

#### `GET /me/notifications`

**P** `notification:read:self` · **cursor**, sort `occurred_at DESC` · default `limit` 20
`query: unreadOnly z.coerce.boolean().default(false), kind optional`
`{ "data": [ NotificationDto ], "page": {…} }` · predicate `dismissed_at IS NULL`.
Empty ⇒ `emptyState.code = "NOTIFICATIONS_NONE"` → "You're all caught up".

#### `GET /me/notifications/unread-count`

**P** `notification:read:self` · **unpaged** · `{ "count": 4, "hasUnread": true }`
Index `ix_notification__unread`. `count: 0` ⇒ the SPA renders no dot — it does not render a
"0" badge.

#### `POST /me/notifications/read`

**P** `notification:mark_read:self` · **I** not required (idempotent) · **`200`**
`body: { ids: z.array(uuid).max(200) } | { all: z.literal(true) }` (exactly one)
`{ "markedCount": 4, "unreadCount": 0 }` — both counts from the database after the write.

#### `POST /me/notifications/:id/dismiss` — **`204`** · sets `dismissed_at`.

### 13.17 Admin / HR — `/api/v1/admin`, `/api/v1/hr`

#### `GET /hr/employees`

**P** `employee:read:any` · **page/limit**, sort `employee_number|full_name|date_of_joining`
`query: q, departmentId, locationId, employmentStatus, managerEmployeeId, page, limit`
Returns the HR employee DTO (an allowlist: identity, employment, manager, status — **not**
the encrypted personal satellite, which needs `profile:read_sensitive:any` on the detail
route). Every list read is audited as `READ_SENSITIVE` when it touches masked columns.

#### `GET /hr/employees/:id` — **P** `employee:read:any` (+ `profile:read_sensitive:any` for the

masked tabs) · the same tabbed shape as `GET /me/profile`, with `canUnmask` reflecting the
actor's permissions.

#### `POST /hr/employees`

**P** `employee:create` · **I** yes · **S** yes

```
body: firstName, middleName?, lastName, preferredName?
      workEmail z.string().email().max(254)
      dateOfJoining z.string().date()
      employmentType z.enum(ess_employment_type)
      designationId, departmentId, locationId, costCentreId  (uuid)
      managerEmployeeId z.string().uuid().optional()
      hrBusinessPartnerEmployeeId z.string().uuid().optional()
      noticePeriodDays z.number().int().min(0).max(180)
      isDirectoryListed z.boolean().default(true)
```

`employee_number` is generated from `employee_number_seq` + the org prefix — **never
client-supplied and never reused**. Creates the `employee`, the effective-dated
`employee_employment`, the `employee_manager` row and rebuilds
`employee_reporting_closure` in the same transaction.
**`201`** the employee. `409 DUPLICATE_RESOURCE` (`constraint="employee_work_email"`).

#### `PATCH /hr/employees/:id` — **If-Match** · **S** yes for statutory/bank sections ·

every write audited with redacted before/after and `changed_fields`.

#### `POST /hr/employees/:id/invite`

**P** `employee:create` · **I** yes · **`202`**
Creates the `app_user` in `INVITED` status with `password_hash = NULL` and queues a
`USER_INVITE` email carrying a one-time activation link. **No default password exists
anywhere in the system** (`SECURITY.md` §10.1).

#### `POST /hr/employees/:id/deactivate` — **P** `employee:deactivate` · **S** yes ·

`body: { dateOfExit, reason (min 10) }` → sets `EXITED`, revokes every session, disables the
user, and rebuilds the reporting closure.

#### `POST /hr/employees/:id/resend-invitation`

**P** `employee:create` · **I** yes · **`202`** · revokes the prior `user_invitation` and
issues a new one. `409 CONFLICT` (`reason="ALREADY_ACTIVATED"`).

#### `POST /hr/employees/:id/suspend` · `…/reinstate`

**P** `employee:update:any` · **I** yes · **S** yes · **If-Match**
`body: { reason z.string().trim().min(10).max(500), paySuspended z.boolean() }`
(`WORKFLOWS.md` EMP-5/EMP-6). `suspend` sets `employment_status = 'SUSPENDED'`, disables the
`app_user` (`token_epoch += 1`, every family revoked), sets
`employee_employment.pay_suspended` per the decision, and emits `SECURITY_ALERT` to HR and
the manager. `reinstate` reverses the employment status and re-enables the user; it does
**not** restore sessions. Both audited with before/after.

#### `POST /hr/employees/:id/resign` · `…/offboard`

**P** `employee:update:any` / `employee:deactivate` · **I** yes · **S** yes on `offboard`
`resign` records `notice_start_date`, `date_of_exit` and moves `ACTIVE → NOTICE_PERIOD`.
`offboard` is the terminal transition to `EXITED` on or after `date_of_exit`: it revokes
every session, disables the user, closes every live `user_role` grant with
`valid_to = date_of_exit`, rebuilds `employee_reporting_closure`, and **reassigns every open
`approval_task` assigned to that employee** to their primary manager — without which an
offboarding silently strands their team's pending approvals. Guard
`employee.no_open_payroll_cycle_scope`. `409 GUARD_FAILED` names the blocking cycle.

#### `POST /admin/users/:userId/disable` · `…/enable`

**P** `employee:deactivate` · **I** yes · **S** yes · `body: { reason (min 10) }` ·
**`204`** (`WORKFLOWS.md` USR-5). The `app_user`-level twin of employment suspension, for the
case where access must be cut without changing employment state.

#### `GET /admin/role-grant-requests` · `POST /admin/role-grant-requests/:id/approve` · `…/reject`

**P** `role:assign` · **I** yes · **S** yes · `body: { note (min 10) }` on reject
The checker half of the two-phase grant below. The approver must be a **different** HR user
from the requester (`409 SEGREGATION_REQUIRED`) and must hold `role:assign` at the time of
approval, not merely when the request was raised. On approve the `user_role` row is created,
`token_epoch += 1` on the target, and `PERMISSION_GRANT` is written naming **both** actors.
Empty queue ⇒ `emptyState.code = "ROLE_GRANTS_NONE_PENDING"`.

#### `GET /admin/roles` — **P** `role:read` · **unpaged** · the four personas with their

permission sets (reference data).

#### `POST /admin/users/:userId/roles`

**P** `role:assign` · **I** yes · **S** **yes** · maker-checker ‡ for `HR`/`ACCOUNTS`/`MANAGER`
`body: { roleId, validFrom?, validTo?, reason z.string().trim().min(10).max(500) }`
For a privileged persona the grant is created **`PENDING_APPROVAL`** in
`role_grant_request` and takes effect only when a **different** HR user approves it; the
response is `202 Accepted` with `{ "status": "PENDING_APPROVAL", "requiresApproverPersona": "HR" }`.
For `EMPLOYEE` it applies immediately (`201`). Either way:
`token_epoch += 1` on the target user on activation (every session re-resolves permissions),
`PERMISSION_GRANT` audit.
Errors: `403 AUTHZ_DENIED` (granting a role to one's own user is refused, §self-dealing) ·
`409 DUPLICATE_RESOURCE` (a live grant already exists) ·
`409 SEGREGATION_REQUIRED` · `422 BUSINESS_RULE_VIOLATED` (`rule="MFA_REQUIRED_FOR_ROLE"` —
the target has no confirmed MFA; the grant is refused and the target is moved to forced
enrolment).

#### `DELETE /admin/users/:userId/roles/:roleId`

**P** `role:assign` · **I** yes · **S** yes · `body: { reason (min 10) }` (required on revoke)
· **`204`** · refuses to revoke `EMPLOYEE` while the employee is `ACTIVE`
(`409 CONFLICT`, `reason="EMPLOYEE_ROLE_IMMUTABLE"`).

#### `POST /admin/users/:userId/revoke-sessions` — **P** `security:session:revoke` · **S** yes ·

**I** yes · `body: { reason }` · revokes every family, bumps `token_epoch`. **`204`**.

#### `POST /admin/users/:userId/reset-mfa` — **P** `security:mfa:reset` · **S** yes · **I** yes ·

disables the credential, invalidates recovery codes, forces enrolment at next login, emails
the user. **`204`**.

#### `GET /admin/org/structure`

**P** `org:read` · **unpaged**
`{ "departments": [ { id, name, businessUnit, parentId, accentColourHex, displayOrder } ],
   "locations":   [ { id, city, siteLabel, holidayCalendarId } ],
   "costCentres": [ { id, code, name } ],
   "designations":[ { id, title, jobLevel } ] }`
`POST`/`PATCH` on each collection require `org:manage`.

#### `GET /admin/audit`

**P** `audit:read` · **cursor**, sort `sequence_no DESC` · **RL** read

```
query: from z.coerce.date(), to z.coerce.date()            // required, max 92-day span
       action z.enum(ess_audit_action).optional()
       entityType z.string().max(64).optional()
       entityId z.string().uuid().optional()
       actorUserId z.string().uuid().optional()
       requestId z.string().uuid().optional()
       persona z.enum(ess_persona).optional()
       limit, cursor
```

`{ "data": [ { "sequenceNo", "occurredAt", "actorEmailSnapshot", "actorRolePersona",
               "actorPermissionCode", "action", "entityType", "entityId", "entityLabel",
               "stateMachine", "fromState", "toState", "changedFields", "reason",
**Scope of `audit:read`differs by persona.** Both HR and Accounts hold`audit:read`
(`DATA-MODEL.md` §3.3), but the audit log is the one place where every module's entity labels
and actor identities meet, so the route resolves a persona predicate into the query rather
than returning the whole table to both:

| Persona                      | `entity_type` the query admits                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HR                           | everything **except** `payslip`, `payslip_line`, `payroll_input_item`, `salary_structure`, `salary_structure_component`, `payslip_fy_rollup` — HR can see that payroll moved and who moved it (`payroll_cycle`, `payroll_run`, `payroll_correction`), never a per-employee amount, matching HR's lack of `payslip:read:any`                                                               |
| ACCOUNTS                     | `payroll_*`, `payslip*`, `salary_structure*`, `expense_*`, `reimbursement_*`, `tax_*`, `form16_document`, `attendance_*`, `file_object`, `email_outbox`, `app_user`(own), plus every event whose `actor_app_user_id` is the actor — never `employee` personal satellites, `profile_change_request_field`, `dependent`, `emergency_contact`, `helpdesk_ticket` or `policy_acknowledgement` |
| Anyone holding both personas | the union, and the read is flagged `metadata.sod_conflict = true`                                                                                                                                                                                                                                                                                                                         |

An actor may always read events **they themselves caused**, whatever the entity type; that is
what makes the log usable for self-defence. `before_data`/`after_data` stay redacted for
everyone. A request for an `entityType` outside the actor's set is `200` with `data: []` and
`emptyState.code = "AUDIT_NO_EVENTS_IN_RANGE"`, never `403` — the existence of events about
an entity is itself information.

               "apiRoute", "httpStatus", "requestId" } ], "page": {…} }`

`before_data`/`after_data` are **omitted from the list** and available only on the detail
route, already redacted (`"<redacted:aes>"` for encrypted columns, money as minor-unit
strings). **Reading the audit log itself writes an `audit_event`** with
`action='READ_SENSITIVE'`.

#### `GET /admin/audit/:id` — the single event including redacted `beforeData`/`afterData`.

#### `GET /admin/audit/chain/verify`

**P** `audit:read` · **unpaged**
`query: from z.coerce.date().optional(), to z.coerce.date().optional()` — **max 31-day span**
(default: last 24 h). A wider range is `400 VALIDATION_FAILED`; verifying the whole chain is
the job of the nightly `audit-chain-verify` worker, which walks it in leased batches and
records its result in `ess_ops.background_job`, not of a synchronous HTTP request that would
otherwise be an unauthenticated-cost amplification against the largest table in the database.
**RL** `user` 6/h.

```jsonc
{
  "organizationId": "…",
  "verifiedFromSequenceNo": 1,
  "verifiedThroughSequenceNo": 918442,
  "eventCount": 4120,
  "isIntact": true,
  "firstMismatchSequenceNo": null,
  "lastAnchor": {
    "sequenceNo": 918000,
    "rowHashHex": "…",
    "signedAt": "…",
    "objectLockUntil": "2031-09-29",
  },
  "verifiedAt": "2026-09-29T04:44:10Z",
  "durationMs": 812,
}
```

Recomputes `row_hash` over the range and compares (`DATA-MODEL.md` §17.1). `isIntact: false`
sets `firstMismatchSequenceNo`, returns `200` (the _verification_ succeeded; its _finding_ is
the failure), pages on-call, and writes a `CONFIG_CHANGE` event on a separate chain. This is
what backs the HR screen's "chain verified through sequence N" banner.

#### `POST /admin/audit/export`

**P** `audit:export` · **I** yes · **S** yes · **RL** `user` 3/h, max 1 concurrent
`body: { from, to, format z.enum(['CSV','JSONL']) }` → **`202 Accepted`**
`{ "exportId": "…", "status": "QUEUED" }`; poll `GET /admin/exports/:id`, then download via
a signed URL. The export itself is an `EXPORT` audit event. CSV cells are prefixed against
formula injection (`SECURITY.md` §5.7).

#### `GET /admin/exports/:id`

**P** the permission of the export's own kind (`audit:export` for an audit export) ·
**unpaged** · **RL** read
`{ "id", "kind": "AUDIT", "status": "QUEUED"|"RUNNING"|"READY"|"FAILED"|"EXPIRED",
   "requestedAt", "finishedAt", "rowCount": 4120, "format": "CSV",
   "expiresAt": "2026-09-30T04:44:10Z", "errorMessage": null }`
Poll interval 2 s, backing off to 10 s after 60 s. `rowCount` is `null` until `READY`.
An export is readable **only by the user who requested it** (`requested_by_user_id = :me`),
expires after 24 h, and its object is deleted by the `export-purge` job at `expiresAt`.

#### `GET /admin/exports/:id/download`

Signed URL per §11 · `409 CONFLICT` (`reason="PDF_NOT_READY"` — reused for any artefact still
generating) while `status <> 'READY'` · `410 GONE` (`code: "CONFLICT"`,
`details.reason = "EXPORT_EXPIRED"`) after `expiresAt`.

#### `GET /admin/email-outbox` — **P** `org:manage` · **cursor** · operational view of

`email_outbox` (`kind`, `status`, `toAddresses`, `retryCount`, `lastError`, `entityType`,
`entityId`). `body_text`/`body_html` are **never** returned.

### 13.18 Health, readiness, version

| Endpoint              | Auth                                                             | Response                                                                                                                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/healthz` | **public**, no rate limit beyond `ip` 60/min                     | `200 {"status":"ok"}` — liveness only; **touches no dependency**, so a dependency outage does not cause a restart loop.                                                                                                                                                                                    |
| `GET /api/v1/readyz`  | internal network interface only (not routable from the internet) | `200 {"status":"ready","checks":{"db":"ok","objectStorage":"ok","kms":"ok","rateLimitStore":"ok","mailProvider":"degraded"}}` or `503 {"status":"not_ready", …}`. `mailProvider: "degraded"` does **not** fail readiness — the outbox absorbs it (§13.14). A failing `db`, `kms` or `rateLimitStore` does. |
| `GET /api/v1/version` | `auth:login`                                                     | `{"apiVersion":"1.0.0","gitSha":"a1b2c3d","builtAt":"…","schemaSha256":"…","payrollEngineVersion":"2.1.0"}` — `schemaSha256` from `ess_ops.schema_guard`, `payrollEngineVersion` from the engine constant recorded on every `payroll_run`. No dependency versions, no hostnames, no env names.             |

`GET /.well-known/jwks.json` is served **only on the internal interface**
(`SECURITY.md` §3.2) and is not part of the public contract.

### 13.19 Transition endpoint index — reconciling with `docs/WORKFLOWS.md`

`docs/WORKFLOWS.md` names each state transition with a **dedicated verb endpoint**
(`POST /leave-requests/:id/approve`, `…/reject`), and it is the authority on which
transitions exist. This contract adopts that naming as **canonical**, with two clarifications
so the two documents describe one API:

1. **Paths in `WORKFLOWS.md` are shorthand.** Every one is prefixed with `/api/v1` and with
   the persona namespace of §1.2. `POST /leave-requests/:id/approve` is
   `POST /api/v1/manager/leave-requests/:id/approve`; `POST /tickets/:id/resolve` is
   `POST /api/v1/hr/tickets/:id/resolve`; `POST /cycles/:id/publish` is
   `POST /api/v1/payroll/cycles/:id/publish`. The namespace is what selects the permission
   and the ABAC scope, so it is not optional.
2. **`…/decide` exists only on the polymorphic approvals queue.** Where §13.4, §13.5 and
   §13.10 above showed `POST …/decide` with an `outcome` field, read that as the pair of
   dedicated endpoints below. The single `POST /api/v1/manager/approvals/:id/decide`
   (§13.15) remains, because the prototype's mixed queue must be actionable without the
   client knowing the module; it dispatches internally to exactly these handlers and shares
   their guards, audit rows and response bodies.

**Complete transition → endpoint table.** Permissions, guards, notifications and emails are
those of the `state_transition` seed row named in `DATA-MODEL.md`; every endpoint takes
`If-Match` and, except where noted, `Idempotency-Key`.

| Machine                  | Transition                             | Endpoint (`/api/v1` + namespace)                                                           | Body                                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leave_request`          | `NULL→DRAFT` / `NULL→PENDING_APPROVAL` | `POST /me/leave-requests` (`submit` flag)                                                  | §13.4                                                                                                                                                                                                                             |
|                          | `DRAFT→PENDING_APPROVAL`               | `POST /me/leave-requests/:id/submit`                                                       | `{}`                                                                                                                                                                                                                              |
|                          | `→APPROVED`                            | `POST /manager/leave-requests/:id/approve`                                                 | `{ note? }`                                                                                                                                                                                                                       |
|                          | `→REJECTED`                            | `POST /manager/leave-requests/:id/reject`                                                  | `{ note (min 10) }`                                                                                                                                                                                                               |
|                          | `→WITHDRAWN`                           | `POST /me/leave-requests/:id/withdraw`                                                     | `{ reason? }`                                                                                                                                                                                                                     |
|                          | `APPROVED→CANCELLED`                   | `POST /hr/leave-requests/:id/cancel`                                                       | `{ reason (min 10) }`                                                                                                                                                                                                             |
|                          | `DRAFT→CANCELLED`                      | `DELETE /me/leave-requests/:id`                                                            | — (no `Idempotency-Key`)                                                                                                                                                                                                          |
| `expense_claim`          | create                                 | `POST /me/expense-claims`                                                                  | §13.10                                                                                                                                                                                                                            |
|                          | `DRAFT→SUBMITTED`                      | `POST /me/expense-claims/:id/submit`                                                       | `{}`                                                                                                                                                                                                                              |
|                          | `→MANAGER_APPROVED`                    | `POST /manager/expense-claims/:id/manager-approve`                                         | `{ approvedAmountMinor?, note? }`                                                                                                                                                                                                 |
|                          | `→MANAGER_REJECTED`                    | `POST /manager/expense-claims/:id/manager-reject`                                          | `{ note (min 10) }`                                                                                                                                                                                                               |
|                          | `→FINANCE_APPROVED`                    | `POST /accounts/expense-claims/:id/finance-approve`                                        | `{ approvedAmountMinor?, note? }`                                                                                                                                                                                                 |
|                          | `→FINANCE_REJECTED`                    | `POST /accounts/expense-claims/:id/finance-reject`                                         | `{ note (min 10) }`                                                                                                                                                                                                               |
|                          | `→WITHDRAWN`                           | `POST /me/expense-claims/:id/withdraw`                                                     | `{ reason? }`                                                                                                                                                                                                                     |
|                          | `DRAFT→CANCELLED`                      | `DELETE /me/expense-claims/:id`                                                            | —                                                                                                                                                                                                                                 |
| `attendance_period`      | `OPEN→HR_SUBMITTED`                    | `POST /hr/attendance/periods/:id/submit`                                                   | §13.5                                                                                                                                                                                                                             |
|                          | `→REOPENED`/`→OPEN`                    | `POST /hr/attendance/periods/:id/reopen`                                                   | `{ reason (min 10) }`                                                                                                                                                                                                             |
| `attendance_approval`    | `→APPROVED`                            | `POST /manager/attendance/approvals/:id/approve`                                           | `{ note? }`                                                                                                                                                                                                                       |
|                          | `→REJECTED`                            | `POST /manager/attendance/approvals/:id/return`                                            | `{ note (min 10) }`                                                                                                                                                                                                               |
|                          | `→AUTO_ESCALATED`                      | `POST /hr/attendance/approvals/:id/escalate`                                               | `{ reason (min 10) }`                                                                                                                                                                                                             |
| `payroll_cycle`          | `NULL→DRAFT`                           | `POST /payroll/cycles`                                                                     | §13.6                                                                                                                                                                                                                             |
|                          | `DRAFT→INPUTS_OPEN`                    | `POST /payroll/cycles/:id/open-inputs`                                                     | `{}`                                                                                                                                                                                                                              |
|                          | `INPUTS_OPEN→INPUTS_LOCKED`            | `POST /payroll/cycles/:id/lock-inputs`                                                     | `{}`                                                                                                                                                                                                                              |
|                          | `VALIDATION_FAILED→INPUTS_OPEN`        | `POST /payroll/cycles/:id/reopen-inputs`                                                   | `{ reason (min 10) }`                                                                                                                                                                                                             |
|                          | `→VALIDATING`                          | `POST /payroll/cycles/:id/validate`                                                        | `{}`                                                                                                                                                                                                                              |
|                          | `→CALCULATING`                         | `POST /payroll/cycles/:id/calculate`                                                       | `{}`                                                                                                                                                                                                                              |
|                          | `CALCULATED→VALIDATED`                 | `POST /payroll/cycles/:id/discard-run`                                                     | `{ reason (min 10) }` — supersedes the run, payslips → `SUPERSEDED`                                                                                                                                                               |
|                          | `→APPROVED`                            | `POST /payroll/cycles/:id/approve`                                                         | `{ note? }` — **step-up**, `payroll.distinct_approver`                                                                                                                                                                            |
|                          | `→PUBLISHED`                           | `POST /payroll/cycles/:id/publish`                                                         | `{ actualPayDate }` — **step-up**                                                                                                                                                                                                 |
|                          | `→CLOSED`                              | `POST /payroll/cycles/:id/close`                                                           | `{}`                                                                                                                                                                                                                              |
|                          | `→CANCELLED`                           | `POST /payroll/cycles/:id/cancel`                                                          | `{ reason (min 10) }`                                                                                                                                                                                                             |
|                          | scope exclusion                        | `POST /payroll/cycles/:id/scope/:employeeId/defer`                                         | `{ reason (min 10) }` — removes one employee from the run before `CALCULATING`; audited per employee                                                                                                                              |
|                          | validation resolve                     | `POST /payroll/cycles/:id/validations/:validationId/resolve`                               | `{ note (min 10) }`                                                                                                                                                                                                               |
| `policy_version`         | create                                 | `POST /hr/policies/:policyId/versions`                                                     | §13.12                                                                                                                                                                                                                            |
|                          | `DRAFT→IN_REVIEW`                      | `POST /hr/policy-versions/:id/submit-review`                                               | `{ note? }`                                                                                                                                                                                                                       |
|                          | `IN_REVIEW→DRAFT`                      | `POST /hr/policy-versions/:id/return`                                                      | `{ note (min 10) }`                                                                                                                                                                                                               |
|                          | `IN_REVIEW→PUBLISHED`                  | `POST /hr/policy-versions/:id/publish`                                                     | `{}` — maker-checker ‡                                                                                                                                                                                                            |
|                          | `→WITHDRAWN`                           | `POST /hr/policy-versions/:id/withdraw`                                                    | `{ reason (min 10) }`                                                                                                                                                                                                             |
|                          | reviewer change                        | `POST /hr/policy-versions/:id/reassign`                                                    | `{ reviewerUserId, note (min 10) }`                                                                                                                                                                                               |
| `policy_acknowledgement` | `NULL→ACKNOWLEDGED`                    | `POST /me/policy-versions/:id/acknowledge`                                                 | §13.12                                                                                                                                                                                                                            |
|                          | `NULL→WAIVED`                          | `POST /hr/policy-assignments/:id/waive`                                                    | `{ reason (min 10) }` — **P** `policy:publish`                                                                                                                                                                                    |
| `document_request`       | create                                 | `POST /me/document-requests`                                                               | §13.11                                                                                                                                                                                                                            |
|                          | `SUBMITTED→IN_REVIEW`                  | `POST /hr/document-requests/:id/claim`                                                     | `{}` — assigns to the actor                                                                                                                                                                                                       |
|                          | `IN_REVIEW→PROCESSING`                 | `POST /hr/document-requests/:id/start`                                                     | `{}`                                                                                                                                                                                                                              |
|                          | `PROCESSING→ISSUED`                    | `POST /hr/document-requests/:id/issue`                                                     | `{ employeeDocumentId \| fileId, note? }`                                                                                                                                                                                         |
|                          | `→REJECTED`                            | `POST /hr/document-requests/:id/reject`                                                    | `{ reason (min 10) }`                                                                                                                                                                                                             |
|                          | `SUBMITTED→CANCELLED`                  | `DELETE /me/document-requests/:id`                                                         | —                                                                                                                                                                                                                                 |
| `helpdesk_ticket`        | create                                 | `POST /me/tickets`                                                                         | §13.14                                                                                                                                                                                                                            |
|                          | `OPEN→ASSIGNED`                        | `POST /hr/tickets/:id/assign`                                                              | `{ assigneeUserId }`                                                                                                                                                                                                              |
|                          | `ASSIGNED→IN_PROGRESS`                 | `POST /hr/tickets/:id/start`                                                               | `{}`                                                                                                                                                                                                                              |
|                          | `IN_PROGRESS→WAITING_ON_EMPLOYEE`      | `POST /hr/tickets/:id/request-info`                                                        | `{ body (min 1) }`                                                                                                                                                                                                                |
|                          | `WAITING_ON_EMPLOYEE→IN_PROGRESS`      | `POST /me/tickets/:id/comments`                                                            | `{ body }`                                                                                                                                                                                                                        |
|                          | `→RESOLVED`                            | `POST /hr/tickets/:id/resolve`                                                             | `{ resolutionSummary (min 10) }`                                                                                                                                                                                                  |
|                          | `RESOLVED→CLOSED`                      | `POST /me/tickets/:id/close`                                                               | `{ satisfactionRating? }`                                                                                                                                                                                                         |
|                          | `RESOLVED→REOPENED`                    | `POST /me/tickets/:id/reopen`                                                              | `{ reason (min 10) }`                                                                                                                                                                                                             |
|                          | `OPEN→CANCELLED`                       | `DELETE /me/tickets/:id`                                                                   | —                                                                                                                                                                                                                                 |
|                          | outbox retry                           | `POST /hr/tickets/:id/retry-notification`                                                  | `{}` — **P** `ticket:assign`; resets the `email_outbox` row (§13.14)                                                                                                                                                              |
| `profile_change_request` | create                                 | `POST /me/profile-change-requests`                                                         | §13.2 — creates `profile_change_request` + `profile_change_request_field`, **not** a `helpdesk_ticket`                                                                                                                            |
|                          | claim                                  | `POST /hr/profile-change-requests/:id/claim`                                               | `{}`                                                                                                                                                                                                                              |
|                          | apply                                  | `PATCH /hr/employees/:id`                                                                  | §13.17 — HR _decides_ via `…/approve`; the **apply** to `employee` is the system transition of §13.5, guarded by `profile.target_row_unchanged_since_submit`. A direct `PATCH` is the manual fallback and is audited identically. |
| `reimbursement_batch`    | create / add / lock / send             | `POST /accounts/reimbursement-batches`, `…/:id/add`, `…/:id/lock`, `…/:id/send-to-payroll` | §13.10                                                                                                                                                                                                                            |
| `app_user`               | `INVITED→ACTIVE`                       | `POST /auth/accept-invitation`                                                             | `{ invitationToken, newPassword, acceptTerms }` — **public**, §13.1                                                                                                                                                               |
|                          | invitation resend                      | `POST /hr/employees/:id/resend-invitation`                                                 | `{}`                                                                                                                                                                                                                              |
|                          | `→DISABLED` / `→ACTIVE`                | `POST /admin/users/:userId/disable` · `…/enable`                                           | `{ reason (min 10) }`                                                                                                                                                                                                             |
|                          | forced password change                 | `POST /auth/password/forced-change`                                                        | `{ changeToken, newPassword }` — **public**, §13.1                                                                                                                                                                                |
| `employee`               | create                                 | `POST /hr/employees`                                                                       | §13.17                                                                                                                                                                                                                            |
|                          | `→SUSPENDED` / `→ACTIVE`               | `POST /hr/employees/:id/suspend` · `…/reinstate`                                           | `{ reason (min 10), paySuspended }`                                                                                                                                                                                               |
|                          | `→NOTICE_PERIOD`                       | `POST /hr/employees/:id/resign`                                                            | `{ noticeStartDate, dateOfExit, reason }`                                                                                                                                                                                         |
|                          | `→EXITED`                              | `POST /hr/employees/:id/offboard` (alias `…/deactivate`)                                   | `{ dateOfExit, reason (min 10) }`                                                                                                                                                                                                 |
| `profile_change_request` | `→APPROVED`                            | `POST /hr/profile-change-requests/:id/approve`                                             | `{ note? }` — **P** `profile:change_request:decide`                                                                                                                                                                               |
|                          | `→REJECTED`                            | `POST /hr/profile-change-requests/:id/reject`                                              | `{ reason (min 10) }`                                                                                                                                                                                                             |
|                          | `APPROVED→APPLIED`                     | _system_ (§13.5 system-transition table)                                                   | —                                                                                                                                                                                                                                 |
| `payroll_correction`     | `NULL→PENDING_APPROVAL`                | `POST /payroll/corrections`                                                                | §13.6                                                                                                                                                                                                                             |
|                          | `→APPROVED` / `→REJECTED`              | `POST /payroll/corrections/:id/approve` · `…/reject`                                       | `{ note (min 10) }` — **step-up**, `payroll.distinct_approver`                                                                                                                                                                    |
| `payslip_publication`    | `→REVOKED`                             | `POST /payroll/publications/:payslipId/revoke`                                             | `{ reason (min 20) }` — **step-up**                                                                                                                                                                                               |
| `role_grant_request`     | `→APPROVED` / `→REJECTED`              | `POST /admin/role-grant-requests/:id/approve` · `…/reject`                                 | `{ note (min 10) }` — maker-checker ‡                                                                                                                                                                                             |
| `mfa_credential`         | enrol / confirm / disable              | `POST /auth/mfa/enrol` · `…/verify-enrolment` · `DELETE /auth/mfa/credentials/:id`         | §13.1 — **R** (re-auth), not **S**                                                                                                                                                                                                |

**Four naming decisions that must not drift:**

- **`PATCH /me/profile` does not exist.** `WORKFLOWS.md` mentions it; an employee cannot
  mutate their own profile directly (Directive 5 — every profile change is a reviewable,
  audited request). The route is `POST /me/profile-change-requests`, and HR applies the
  change through `PATCH /hr/employees/:id`. If a genuinely self-service field is wanted later
  (preferred name, say), it gets its own narrow endpoint with its own permission, not a
  general `PATCH`.
- **`DELETE` is used only for `DRAFT`→`CANCELLED` on records the actor owns and that nobody
  has seen.** It never hard-deletes; it performs the `CANCELLED` transition and returns
  `204`. Everything else is a named `POST` verb, so the audit trail records an intent rather
  than an absence.

- **One path per transition — no aliases.** Three paths appeared twice in earlier drafts and
  exactly one spelling of each is routed; the other returns `404` like any unknown route:

  | Transition              | **Routed**                                        | Not routed                            |
  | ----------------------- | ------------------------------------------------- | ------------------------------------- |
  | policy acknowledgement  | `POST /me/policy-versions/:versionId/acknowledge` | `/me/policies/:versionId/acknowledge` |
  | profile change request  | `POST /me/profile-change-requests`                | `/me/profile/change-request`          |
  | reimbursement batch add | `POST /accounts/reimbursement-batches/:id/add`    | `…/items`                             |

  An alias would break CI invariant 3a (exactly one route per `state_transition` seed row) and
  would let two handlers drift apart while both look canonical. Where §13 above still shows a
  non-routed spelling in prose, this table wins.

- **Permissions that exist in `DATA-MODEL.md` §3.1 but are bound to no route in v1** are
  listed so they are a conscious deferral rather than an unreachable capability:
  `leave:balance:adjust`, `leave:config:manage`, `holiday:manage`, `benefit:manage`,
  `dependent:verify`, `expense:config:manage`, `expense:claim:approve:skip_level`,
  `document:type:manage`, `ticket:config:manage`, `payroll:component:manage`,
  `payroll:statutory:manage`, `org:setting:update`, `role:manage`,
  `report:{payroll,leave,expense}:read`, `leave:request:approve:any`,
  `announcement:*` beyond the routes of §13.13, `tax:declaration:read:any`.
  Each is either exercised by a seeded back-office screen out of scope for v1 or by a
  migration/ops path; **none is reachable from the SPA**, and CI invariant 3b asserts that an
  unbound permission appears on this list, so adding a permission without a route (or a
  deferral note) fails the build.

---

## 14. Appendix A — prototype screen → endpoints

Screens are the `<sc-if value="{{ isXxx }}">` sections of
`design/prototype/prototype-markup.html`. "On mount" fires in parallel; the shell calls are
made once per session and cached by TanStack Query.

### Shell (every screen)

| Element                                                             | Endpoint                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Sidebar org name / portal name / logo, user card, header name+title | `GET /me`                                                                                 |
| Nav groups, items, approvals badge, policy badge, unread dot        | `GET /me/bootstrap`                                                                       |
| Header date                                                         | `GET /me` → `serverTime` + `organization.timezone`                                        |
| Global search dropdown (`Module`/`Person`/`Policy`/`Payslip`)       | `GET /search?q=` (debounced 250 ms)                                                       |
| Notifications popover                                               | `GET /me/notifications?limit=20`; dot from `GET /me/notifications/unread-count`           |
| Notification click → deep link                                      | `deepLink.screen` + `deepLink.params`; then `POST /me/notifications/read`                 |
| "More" sheet nav list                                               | `GET /me/bootstrap` (same manifest)                                                       |
| Org logo image                                                      | `GET /org/logo` (§11.1) — `null` ⇒ the SPA renders the wordmark, never a stock image      |
| Server clock for every relative label                               | `GET /me` → `serverTime` (§12.18); the SPA never calls `Date.now()` for a displayed value |
| Session list (security screen)                                      | `GET /auth/sessions`, `DELETE /auth/sessions/:sessionId`                                  |
| Step-up dialog                                                      | `POST /auth/mfa/step-up`; password re-auth dialog `POST /auth/reauth`                     |

### Home (`isHome`)

| Element                                             | Endpoint / field                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Greeting + sub-header                               | `GET /me/home` → `greetingKey`, `subHeader`                                    |
| Latest payslip card (net, credited, Download PDF)   | `GET /me/home` → `latestPayslip`; download via `GET /me/payslips/:id/download` |
| — its empty state                                   | `latestPayslipEmptyState`                                                      |
| Leave balance card (top 3 + bars)                   | `GET /me/home` → `leaveBalancesTop3`                                           |
| Approvals card (count, 2-row preview, "Review all") | `GET /me/home` → `approvals` (omitted for non-managers)                        |
| Announcements card (3)                              | `GET /me/home` → `announcements`                                               |
| Upcoming holidays (4) + calendar name               | `GET /me/home` → `holidays`, `holidayCalendarName`                             |
| Team today                                          | `GET /me/home` → `team` (omitted with no direct reports)                       |
| "Needs your attention"                              | `GET /me/home` → `todos` (`[]` ⇒ block omitted)                                |
| "Apply leave" / "Raise ticket" buttons              | client navigation only                                                         |
| A block that timed out                              | `GET /me/home` → `partial[]` names it; the SPA refetches that block alone      |

### Payslips (`isPayslips`)

| Element                                                                                    | Endpoint                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| FY chip, bank line, 4 YTD tiles, list                                                      | `GET /me/payslips` → `fiscalYear`, `bankLine`, `ytd`, `data` |
| Detail panel (net, credited, days paid, earnings, deductions, employer PF, TDS, reference) | `GET /me/payslips/:id`                                       |
| Download PDF                                                                               | `GET /me/payslips/:id/download`                              |
| Email me                                                                                   | `POST /me/payslips/:id/email`                                |
| Empty state                                                                                | `GET /me/payslips` → `emptyState`                            |

### Tax slips (`isTax`)

| Element                                                              | Endpoint                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| PAN chip, regime chip, TDS summary card, progress bar, 3 sub-figures | `GET /me/tax/summary`                                            |
| Investment declaration card + window copy                            | `GET /me/tax/declaration`                                        |
| "Update declaration"                                                 | `PUT /me/tax/declaration` then `POST /me/tax/declaration/submit` |
| Quarterly TDS rows                                                   | `GET /me/tax/quarters`                                           |
| Form 16 list + Download                                              | `GET /me/tax/form16`, `GET /me/tax/form16/:id/download`          |

### My profile (`isProfile`)

| Element                           | Endpoint                                                           |
| --------------------------------- | ------------------------------------------------------------------ |
| Header block + chips              | `GET /me/profile` → `header`                                       |
| Tab strip + field grid + tab note | `GET /me/profile?tab=personal                                      | employment | bank | emergency` |
| Emergency tab rows                | `GET /me/emergency-contacts`                                       |
| "Request a change"                | `POST /me/profile-change-requests` → toast shows `ticket.ticketNo` |
| (Unmask a masked value)           | `POST /me/profile/unmask` after step-up                            |

### Policies (`isPolicies`)

| Element                                                    | Endpoint                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| "N awaiting acknowledgement" chip                          | `GET /me/policies` → `pendingCount` (0 ⇒ chip omitted)                     |
| List rows + status chips                                   | `GET /me/policies` → `data`                                                |
| Detail (eyebrow, title, summary, 4-up meta, bullet points) | `GET /me/policies/:versionId`                                              |
| "I have read and acknowledge" + "Due …"                    | `POST /me/policy-versions/:versionId/acknowledge`; due from `dueOn`        |
| "Acknowledged on …"                                        | `acknowledgedAt` from the response / list                                  |
| Download PDF                                               | `GET /me/policies/:versionId/download` (omitted when `pdfAvailable` false) |

### Leave (`isLeave`)

| Element                                         | Endpoint                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| Sub-header "Leave year …"                       | `GET /me/leave/balances` → `leavePeriod.label`                   |
| Balance tiles + bars                            | `GET /me/leave/balances`                                         |
| Type dropdown                                   | `GET /leave/types`                                               |
| Submit request                                  | `POST /me/leave-requests` (server computes `totalDays`)          |
| "Weekends are not counted"                      | derived from `organization.week_off_days` via `GET /me`          |
| My requests + Withdraw                          | `GET /me/leave-requests`, `POST /me/leave-requests/:id/withdraw` |
| Upcoming holidays + "1 restricted holiday left" | `GET /leave/holidays`; RH count from `GET /me/leave/balances`    |

### Benefits (`isBenefits`)

| Element                                                                 | Endpoint                                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Plan-year sub-header, cards (eyebrow, name, value, meta, action)        | `GET /me/benefits`                                                           |
| Card action (`Download e-card` / `View policy` / `Change contribution`) | `action.kind` → `GET …/ecard`, plan-document download, or `POST /me/tickets` |
| Dependents list + "Add dependent"                                       | `GET /me/dependents`, `POST /me/dependents` (window-guarded)                 |

### Expenses (`isExpenses`)

| Element                                                | Endpoint                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| 3 stat tiles                                           | `GET /me/expense-claims` → `stats`                                    |
| "New claim" form (category, amount, date, description) | `GET /expenses/categories` + `POST /me/expense-claims`                |
| "Attach bill"                                          | `POST /files` (`purpose=EXPENSE_BILL`) then `attachmentFileIds`       |
| "Goes to X, then Finance"                              | `stats[0].subLabel` manager name + category `requiresFinanceApproval` |
| My claims list + chips + rejection note                | `GET /me/expense-claims`                                              |

### Documents (`isDocuments`)

| Element                              | Endpoint                                                              |
| ------------------------------------ | --------------------------------------------------------------------- |
| Letter-type dropdown + SLA copy      | `GET /documents/letter-templates`                                     |
| "Request letter"                     | `POST /me/document-requests`                                          |
| Letter requests list + download icon | `GET /me/document-requests`, `GET /me/document-requests/:id/download` |
| My documents list + download         | `GET /me/documents`, `GET /me/documents/:id/download`                 |

### Directory (`isDirectory`)

| Element                                  | Endpoint                                   |
| ---------------------------------------- | ------------------------------------------ |
| "N people shown"                         | `GET /directory/people` → `page.total`     |
| Search box                               | same endpoint with `q` (debounced)         |
| Person card (email, phone, "Reports to") | `GET /directory/people/:employeeId`        |
| Reporting-line strip                     | `GET /me/reporting-line`                   |
| "No one matches …"                       | `emptyState.code = "DIRECTORY_NO_MATCHES"` |

### Announcements (`isAnnouncements`)

| Element                               | Endpoint                                                            |
| ------------------------------------- | ------------------------------------------------------------------- |
| List (pinned badge, dept · date)      | `GET /me/announcements`                                             |
| Detail (body paragraphs, "Posted by") | `GET /me/announcements/:id`; then `POST /me/announcements/:id/read` |

### Help desk (`isHelp`)

| Element                               | Endpoint                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| "first response within 1 working day" | `GET /help-desk/categories` → `firstResponseSlaLabel`                                |
| Category dropdown                     | `GET /help-desk/categories`                                                          |
| Submit ticket                         | `POST /me/tickets` (persists **and** enqueues the `helpdesk@widedroptech.com` email) |
| My tickets list                       | `GET /me/tickets`                                                                    |
| FAQ accordion                         | `GET /help-desk/faq` (no rows ⇒ card not rendered)                                   |

### Approvals (`isApprovals`, Manager only)

| Element                                                      | Endpoint                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| "· 3 reports"                                                | `GET /manager/approvals` → `directReportCount`                |
| "Pending · N" tab                                            | `GET /manager/approvals` → `page.total`                       |
| Pending cards (avatar, kind chip, title, sub, "Requested …") | `GET /manager/approvals` → `data`                             |
| Approve / Reject                                             | `POST /manager/approvals/:id/decide`                          |
| "All caught up"                                              | `emptyState.code = "APPROVALS_ALL_CAUGHT_UP"`                 |
| History tab                                                  | `GET /manager/approvals/history`                              |
| Team today aside                                             | `GET /me/home` → `team`                                       |
| Aside note ("Upcoming: … Dussehra week …")                   | `GET /manager/leave/team-calendar` (zero rows ⇒ note omitted) |

### Back-office screens (new, role-gated groups appended after `Manager`)

| Screen                                              | Endpoints                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Payroll cycles** (Accounts)                       | `GET /payroll/cycles`, `POST /payroll/cycles`, `…/open-inputs`; step tracker from `stepTracker`                                                              |
| **Payroll inputs** (Accounts)                       | `POST /files` (`PAYROLL_INPUT_UPLOAD`) → `POST /payroll/cycles/:id/input-batches` → `GET …/items` → `POST …/commit` → `POST /payroll/cycles/:id/lock-inputs` |
| **Validation** (Accounts)                           | `POST /payroll/cycles/:id/validate`, `GET …/validation-results`, `POST …/resolve`                                                                            |
| **Calculate / register / publish**                  | `POST …/calculate`, `GET /payroll/runs/:runId`, `GET /payroll/cycles/:id/payslips`, `POST …/approve`, `POST …/publish`, `POST …/close`                       |
| **Attendance capture** (HR)                         | `GET /hr/attendance/periods`, `GET …/records`, `PUT …/records/:employeeId`, `POST …/records:bulk`                                                            |
| **Attendance submission** (HR)                      | `POST /hr/attendance/periods/:id/submit` — blocked with `submitBlockers[]` until Accounts locks inputs                                                       |
| **Attendance approvals** (Manager)                  | `GET /manager/attendance/approvals`, `GET …/:id/records`, `POST …/:id/decide`                                                                                |
| **Policy authoring** (HR)                           | `GET/POST /hr/policies`, `POST /hr/policies/:id/versions`, `PATCH`, `POST …/publish`                                                                         |
| **Policy compliance** (HR)                          | `GET /hr/policies/versions/:versionId/compliance`                                                                                                            |
| **Ticket queue** (HR)                               | `GET /hr/tickets`, `POST …/assign`, `…/comments`, `…/resolve`                                                                                                |
| **Employee admin** (HR)                             | `GET/POST /hr/employees`, `PATCH /hr/employees/:id`, `POST …/invite`, `POST …/deactivate`                                                                    |
| **Roles** (HR)                                      | `GET /admin/roles`, `POST /admin/users/:id/roles`, `DELETE …/roles/:roleId`                                                                                  |
| **Payroll corrections** (Accounts)                  | `GET/POST /payroll/corrections`, `POST /payroll/corrections/:id/approve`, `POST /payroll/publications/:payslipId/revoke`                                     |
| **Profile change requests** (HR)                    | `GET /hr/profile-change-requests`, `POST …/:id/claim`, `…/approve`, `…/reject`, then `PATCH /hr/employees/:id`                                               |
| **Employee lifecycle** (HR)                         | `POST /hr/employees/:id/{invite,resend-invitation,suspend,reinstate,resign,offboard}`                                                                        |
| **Role grant approvals** (HR)                       | `GET /admin/role-grant-requests`, `POST …/:id/approve`, `…/reject`                                                                                           |
| **Approval oversight** (HR)                         | `GET /hr/approvals`, `POST /hr/attendance/approvals/:id/escalate`                                                                                            |
| **Email outbox** (HR)                               | `GET /admin/email-outbox`, `POST /admin/email-outbox/:id/retry`                                                                                              |
| **Exports**                                         | `POST /admin/audit/export` → `GET /admin/exports/:id` → `GET /admin/exports/:id/download`                                                                    |
| **Audit log** (HR scoped, Accounts scoped — §13.17) | `GET /admin/audit`, `GET /admin/audit/chain/verify`, `POST /admin/audit/export`                                                                              |

---

## 15. Appendix B — rate-limit index

Buckets follow `SECURITY.md` §9.1–9.4. Every route declares one; the boot assertion fails a
route with none.

| Route class                                                                           | Key                            | Limit                                                                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/login`                                                                    | `ip` / `account` / `ip`(spray) | 10 / 15 min · 10 / 15 min · 60 / 60 min                                                                                |
| `POST /auth/mfa/challenge`, `/auth/mfa/step-up`                                       | `user`                         | 5 / 5 min, then 15 min cooldown                                                                                        |
| `POST /auth/mfa/enrol`, `/mfa/recovery-codes`                                         | `user`                         | 5 / 60 min                                                                                                             |
| `POST /auth/password-reset/request`                                                   | `ip` / `account`               | 5 / 60 min · 3 / 60 min (still returns `202`)                                                                          |
| `POST /auth/password-reset/confirm`                                                   | `ip`                           | 10 / 60 min                                                                                                            |
| `POST /auth/refresh`                                                                  | `session`                      | 60 / 5 min                                                                                                             |
| `GET /search`                                                                         | `user`                         | 30 / 1 min                                                                                                             |
| `GET /directory/people`                                                               | `user`                         | 60 / 1 min                                                                                                             |
| `POST /files`                                                                         | `user`                         | 20 / 1 h **and** 200 MiB / 24 h                                                                                        |
| Any `*/download` (signed-URL mint)                                                    | `user`                         | 120 / 1 h                                                                                                              |
| `POST /me/tickets`                                                                    | `user`                         | 10 / 1 h                                                                                                               |
| `POST /me/policies/:id/acknowledge`                                                   | `user`                         | 30 / 1 h                                                                                                               |
| Any `*/decide` (approval decisions)                                                   | `user`                         | 200 / 1 h + `SECURITY.RATE_LIMIT_TRIPPED`                                                                              |
| `POST /payroll/cycles/:id/input-batches`, `…/publish`, `…/calculate`                  | `user`                         | 10 / 1 h                                                                                                               |
| `POST /me/profile/unmask`, `GET /payroll/salary-structures/:id`                       | `user`                         | **30 / 1 h + CRITICAL alert on trip**                                                                                  |
| `POST /admin/audit/export`                                                            | `user`                         | 3 / 1 h, max 1 concurrent                                                                                              |
| General authenticated `GET`                                                           | `user`                         | 300 / 1 min                                                                                                            |
| General authenticated write                                                           | `user`                         | 60 / 1 min                                                                                                             |
| `GET /healthz`                                                                        | `ip`                           | 60 / 1 min                                                                                                             |
| `POST /auth/reauth`                                                                   | `user`                         | 5 / 5 min, then 15 min cooldown                                                                                        |
| `POST /auth/accept-invitation`                                                        | `ip` / invitation `token_fpr`  | 10 / 60 min · 5 / 60 min (then the invitation is revoked at 5 failed hashes)                                           |
| `POST /auth/password/forced-change`                                                   | `ip` / `changeToken`           | 10 / 60 min · 3 / 15 min                                                                                               |
| `POST /payroll/corrections`, `…/:id/approve`, `POST /payroll/publications/:id/revoke` | `user`                         | 10 / 1 h + `SECURITY.RATE_LIMIT_TRIPPED` at CRITICAL                                                                   |
| `GET /admin/audit/chain/verify`                                                       | `user`                         | 6 / 1 h (max 31-day span, §13.17)                                                                                      |
| `GET /admin/exports/:id` (poll)                                                       | `user`                         | 120 / 1 h                                                                                                              |
| `PUT /hr/attendance/periods/:id/records/:employeeId`                                  | `user`                         | 600 / 1 h — the HR grid is edited cell by cell and the general write bucket (60/min) would throttle legitimate capture |
| `GET /me/home`, `GET /me/bootstrap`                                                   | `user`                         | 120 / 1 min (composites; the SPA must not poll them)                                                                   |
| `POST /me/leave-requests`, `POST /me/expense-claims`, `POST /me/document-requests`    | `user`                         | 30 / 1 h each                                                                                                          |
| Any unauthenticated request to a non-existent route                                   | `ip`                           | 120 / 1 min (404 flood / route-scanning brake)                                                                         |

The limiter **fails closed on auth routes** (`503 UNAVAILABLE`) and fails open with a `WARN`
on general reads if its store is unavailable.

---

## 16. Appendix C — `emptyState` code catalogue

Every code, its owning endpoint, and the persisted `params` that make its message true. Copy
lives in `ui_copy`; the SPA never composes these sentences.

| Code                               | Endpoint                                                             | `params`                                    |
| ---------------------------------- | -------------------------------------------------------------------- | ------------------------------------------- |
| `PAYSLIPS_CYCLE_IN_PROGRESS`       | `GET /me/payslips`                                                   | `periodLabel`, `cycleStatus`                |
| `PAYSLIPS_NO_CYCLE_YET`            | `GET /me/payslips`                                                   | `dateOfJoining`                             |
| `PAYSLIPS_REVOKED`                 | `GET /me/payslips`                                                   | `periodLabel`                               |
| `LEAVE_NO_BALANCES`                | `GET /me/leave/balances`                                             | `nextAccrualOn`                             |
| `LEAVE_NO_REQUESTS`                | `GET /me/leave-requests`                                             | `leavePeriodLabel`                          |
| `ATTENDANCE_NOT_FINALISED`         | `GET /me/attendance`                                                 | `periodLabel`, `periodStatus`               |
| `TAX_NO_PROJECTION`                | `GET /me/tax/summary`                                                | `fiscalYearLabel`                           |
| `TAX_NO_DECLARATION`               | `GET /me/tax/declaration`                                            | `declarationOpensOn`, `declarationClosesOn` |
| `FORM16_NOT_ISSUED`                | `GET /me/tax/form16`                                                 | `fiscalYearLabel`, `expectedByDate`         |
| `PROFILE_TAB_EMPTY`                | `GET /me/profile`                                                    | `tab`                                       |
| `BENEFITS_NONE_ACTIVE`             | `GET /me/benefits`                                                   | `planYearLabel`                             |
| `BENEFIT_AWAITING_PAYSLIP`         | `GET /me/benefits` (per card)                                        | `planName`                                  |
| `DEPENDENTS_NONE`                  | `GET /me/dependents`                                                 | `enrolmentOpensOn`, `enrolmentClosesOn`     |
| `EXPENSES_NONE_IN_FY`              | `GET /me/expense-claims`                                             | `fiscalYearLabel`                           |
| `DOCUMENTS_NONE`                   | `GET /me/documents`                                                  | —                                           |
| `DOCUMENT_REQUESTS_NONE`           | `GET /me/document-requests`                                          | —                                           |
| `POLICIES_NONE_ASSIGNED`           | `GET /me/policies`                                                   | —                                           |
| `DIRECTORY_NO_MATCHES`             | `GET /directory/people`                                              | `query`                                     |
| `ANNOUNCEMENTS_NONE`               | `GET /me/announcements`                                              | —                                           |
| `TICKETS_NONE`                     | `GET /me/tickets`                                                    | —                                           |
| `NOTIFICATIONS_NONE`               | `GET /me/notifications`                                              | —                                           |
| `APPROVALS_ALL_CAUGHT_UP`          | `GET /manager/approvals`                                             | —                                           |
| `APPROVALS_NO_HISTORY`             | `GET /manager/approvals/history`                                     | —                                           |
| `PAYROLL_NO_CYCLES`                | `GET /payroll/cycles`                                                | `fiscalYearLabel`                           |
| `PAYROLL_NO_INPUT_BATCHES`         | `GET /payroll/cycles/:id/input-batches`                              | `cycleLabel`, `cycleStatus`                 |
| `PAYROLL_NO_VALIDATION_RESULTS`    | `GET …/validation-results`                                           | `cycleLabel`                                |
| `ATTENDANCE_NO_RECORDS`            | `GET /hr/attendance/periods/:id/records`                             | `periodLabel`                               |
| `HR_NO_TICKETS_IN_QUEUE`           | `GET /hr/tickets`                                                    | —                                           |
| `AUDIT_NO_EVENTS_IN_RANGE`         | `GET /admin/audit`                                                   | `from`, `to`                                |
| `PAYSLIPS_NO_PUBLISHED_CYCLE`      | _(retired — use `PAYSLIPS_CYCLE_IN_PROGRESS`)_                       | —                                           |
| `APPROVALS_NONE_ORG_WIDE`          | `GET /hr/approvals`                                                  | —                                           |
| `ATTENDANCE_NO_PERIODS`            | `GET /hr/attendance/periods`                                         | `fiscalYearLabel`                           |
| `ATTENDANCE_NO_SLICES`             | `GET /manager/attendance/approvals`                                  | `periodLabel`                               |
| `PAYROLL_NO_PAYSLIPS_IN_CYCLE`     | `GET /payroll/cycles/:id/payslips`                                   | `cycleLabel`, `cycleStatus`                 |
| `PAYROLL_NO_CORRECTIONS`           | `GET /payroll/corrections`                                           | `fiscalYearLabel`                           |
| `PAYROLL_NO_INPUT_ITEMS`           | `GET …/input-batches/:batchId/items`                                 | `batchNo`                                   |
| `HOLIDAYS_NONE_IN_RANGE`           | `GET /leave/holidays`                                                | `calendarName`, `from`, `to`                |
| `LEAVE_TYPES_NONE_ELIGIBLE`        | `GET /leave/types`                                                   | `employmentType`                            |
| `TEAM_CALENDAR_EMPTY`              | `GET /manager/leave/team-calendar`                                   | `from`, `to`                                |
| `REPORTING_LINE_EMPTY`             | `GET /me/reporting-line`                                             | —                                           |
| `EMERGENCY_CONTACTS_NONE`          | `GET /me/emergency-contacts`                                         | —                                           |
| `NOMINEES_NONE`                    | `GET /me/nominees`                                                   | `planYearLabel`                             |
| `SESSIONS_ONLY_CURRENT`            | `GET /auth/sessions`                                                 | —                                           |
| `PROFILE_CHANGE_REQUESTS_NONE`     | `GET /me/profile-change-requests`, `GET /hr/profile-change-requests` | —                                           |
| `HR_NO_DOCUMENT_REQUESTS`          | `GET /hr/document-requests`                                          | —                                           |
| `POLICY_COMPLIANCE_NO_ASSIGNMENTS` | `GET /hr/policies/versions/:id/compliance`                           | `versionLabel`                              |
| `HR_NO_EMPLOYEES_MATCH`            | `GET /hr/employees`                                                  | `query`                                     |
| `ROLE_GRANTS_NONE_PENDING`         | `GET /admin/role-grant-requests`                                     | —                                           |
| `EMAIL_OUTBOX_EMPTY`               | `GET /admin/email-outbox`                                            | `status`                                    |
| `SEARCH_NO_MATCHES`                | `GET /search`                                                        | `query`                                     |
| `EXPORTS_NONE`                     | `GET /admin/exports`                                                 | —                                           |

Two rules make this table load-bearing rather than decorative:

1. **Every `GET` collection or metric endpoint in §13 appears here or states in its own block
   that it emits no `emptyState`** (because "there is nothing" needs no explanation —
   `GET /me/payslips/:id`'s line arrays, for instance). CI invariant 17 (§17) calls every
   `GET` against an empty database as each persona and asserts either a catalogued code or a
   documented silent empty.
2. **A code names one cause, not one screen.** Where two causes produce the same empty list
   (no cycle yet vs. cycle in progress vs. revoked), there are three codes, because the copy
   an employee needs differs and the SPA must not choose between them.

---

## 17. Appendix D — route-table invariants enforced in CI

`apps/api/test/routes.contract.test.ts` walks the printed Fastify route table and fails the
build unless **all** of the following hold. These are the machine-checkable restatement of
this contract.

1. Every route declares exactly one of `config.permission` (a single seeded code) or
   `config.public` (with a `reason` and, where bearer-less, a `boundToken`). A second
   capability is expressed as `config.alsoRequires` / `config.conditionalFields` (§5), never
   as a second `config.permission`.
2. The only `config.public` routes are the eight of §4.1, and `OPTIONS` (CORS preflight).
3. Every `config.permission`, `alsoRequires` and `conditionalFields` key exists in the
   seeded `permission.code` set of `DATA-MODEL.md` §3.1, **and** is granted to at least one
   persona in §3.3 — a route guarded by a permission nobody holds is dead code, not security.
   3a. Every `state_transition` seed row is bound to **exactly one** route, or is marked
   `is_system = true` and appears in the system-transition table of §13.5. Two routes bound
   to one transition (an alias) fails the build, which is what keeps §13.19's
   "no aliases" table true.
   3b. Every seeded permission is bound to at least one route **or** appears on the deferral
   list at the end of §13.19.
   3c. No route declares a permission held by MANAGER that ends in `:any`; the
   assertion is written against the §3.3 grant sets, so re-introducing
   `approval:task:read:any` on a `/manager/**` route fails the build.
4. No `GET`/`HEAD` route declares a write-class permission — any code containing
   `:create`, `:update`, `:write`, `:approve`, `:publish`, `:submit`, `:withdraw`,
   `:acknowledge`, `:assign`, `:resolve`, `:reimburse`, `:capture`, `:commit`, `:upload`,
   `:issue`, `:manage`, `:adjust`, `:verify`, `:act`, `:revoke` or `:reset`. Reference-data
   reads declare `org:read` (§13.4).
5. Every route declares `params`, `querystring`, `body` and `response` Zod schemas; every
   object schema is `.strict()` except `headers`, which is `.passthrough()`.
6. Every `response` map includes `400`, `429` and `500` bound to `ErrorDto`; every
   **non-public** route additionally includes `401` and `403`; every route taking a path
   parameter includes `404`; every route declaring `requireIfMatch` includes `409` and `428`;
   every route declaring `idempotent` includes `409` and `422`. `GET /healthz` declares only
   `200` and `429`. (The previous blanket rule was unsatisfiable for the public routes.)
7. Every route declares `config.rateLimit` (or explicitly opts into the general bucket).
8. Every endpoint in §8.2 declares `config.idempotent: true`, and no endpoint in §8.3 does.
9. Every route whose resource table has `row_version` and whose method is
   `PATCH`/`PUT`/state-changing `POST` declares `config.requireIfMatch: true`, **except** the
   three set-addressed routes enumerated in §9, which are named in the test as a literal
   allowlist so a fourth exemption cannot be added silently.
10. Every route in the step-up set of §4.3 declares `config.stepUp: true`, and every route
    in the re-auth set declares `config.reauth: true`. A route declaring `stepUp` that is not
    in either list fails, so the set cannot quietly grow or shrink.
11. No route handler returns a Prisma model object (ESLint `no-restricted-syntax`); every
    response passes through a named DTO mapper.
12. Every `emptyState.code` emitted anywhere in the codebase exists in Appendix C **and** has
    a matching `ui_copy` key seeded.
13. Every `error.code` emitted anywhere exists in the §2.3 catalogue.
14. No response schema contains a field named `*_ct`, `*_iv`, `*_tag`, `*_dek_id`,
    `password*`, `*token_hash`, `*secret*`, `*_mask` (the DTO field is `masked`, not the
    column), or `sha256` of a credential; and no response schema contains a `string` field
    whose name ends in `Amount`, `Total`, `Pay`, `Salary` or `Minor` — money is an integer
    field named `…Minor` inside a `MoneyDto`, so a formatted currency string cannot be
    serialised anywhere (§1.5).
15. Every collection route declares its pagination style, and its `page` object matches that
    style's schema exactly.
16. A matrix-driven test issues a real request for every (persona, permission) pair marked
    "no grant" and asserts `403`/`404`; a scope test asserts a manager cannot reach a
    non-report; a multi-persona test covers the worked examples of `SECURITY.md` §4.7.
17. **Directive-2 test:** a fixture run against an **empty** database (reference data only,
    per `DATA-MODEL.md` §18.2) calls every `GET` in §13 as each of the four personas and
    asserts `200` with `data: []` / `value: null` and a valid `emptyState` — **never** a
    `404`, a `500`, or a non-null operational figure.
18. **Directive-6 test:** a payroll ordering test drives a cycle and asserts that
    `POST /hr/attendance/periods/:id/submit` returns `409 GUARD_FAILED`
    (`attendance.payroll_inputs_locked`) before `lock-inputs`; that
    `POST /payroll/cycles/:id/validate` returns `409` before every attendance slice is
    approved; that `GET /me/payslips` returns `200` with `data: []` at every stage before
    `publish`; and that it returns the payslip immediately after.
19. **Enum-ordering ban:** a lint rule and a repository-wide grep fail the build on any
    Prisma/SQL comparison of an `ess_*` enum column with `lt`/`lte`/`gt`/`gte` or `<`/`>`
    (§1.5). Allowed forms are `in`/`notIn` and equality.
20. **No formatted money, ever:** a response-schema walker asserts no `emptyState.params`
    value, no `notification` payload and no `email_outbox.template_data` schema admits a
    string matching `/[₹$]|^\d[\d,]*\.\d{2}$/`.
21. **Directive-7 test:** publishing a policy version and acknowledging it persists
    `policy_acknowledgement` with `employee_id`, `policy_version_id`,
    `acknowledged_body_sha256` and `acknowledged_at`; a second acknowledgement of the same
    assignment returns `200` with the **same** id and timestamp; acknowledging with a stale
    `bodySha256` is `422 BODY_HASH_MISMATCH`; and superseding the version leaves the old
    acknowledgement row untouched while creating a new pending assignment.
22. **Directive-8 test:** `POST /me/tickets` commits the `helpdesk_ticket` and exactly one
    `email_outbox` row addressed to `helpdesk@widedroptech.com` in one transaction; forcing
    the mail provider to fail leaves the ticket `OPEN`, assignable and commentable, and the
    outbox row `QUEUED`→`FAILED` after `max_retries`, with the employee-facing `TicketDto`
    never exposing `notificationEmailStatus`.
23. **Payslip-visibility fuzz:** for every `payroll_cycle.status` and every combination of
    `payslip.status` × publication presence × `revoked_at`, `GET /me/payslips` and
    `GET /me/payslips/:id` return a payslip **iff** a live publication exists — asserted by
    enumerating the cross product, not by sampling.
24. **Composed-label provenance:** every string returned by a DTO mapper that is not a
    verbatim column value is produced by a `ui_copy` lookup or a §12.18 formatter; a literal
    template string in a mapper file fails an ESLint rule (`no-inline-user-copy`).

---

## 18. Open risks and reconciliations

**Status key.** `RESOLVED` — this revision decided it and the decision is above;
`OPEN` — it still needs a person. Nothing below is left for an implementer to invent: an
`OPEN` item names who must decide and what the default is until they do.

1. `RESOLVED` — **Permission-string grammar.** `DATA-MODEL.md` §3.1 seeds codes as
   `<resource>:<action>[:<scope>]` (`leave:request:approve:team`) with a `CHECK` on that
   shape; `SECURITY.md` §4.3 documents `verb:resource[:qualifier]` (`read:payslip:self`).
   **This contract uses the `DATA-MODEL.md` spelling throughout**, because those codes are
   seeded reference data and are FK-referenced by
   `state_transition.required_permission_code` — they are load-bearing in the database, while
   the security doc's form appears only in prose. `SECURITY.md` §4.3–4.4 should be rewritten
   to the seeded spelling before implementation, or a translation table pinned in
   `packages/shared/src/permissions.ts`. Leaving both forms alive is the single most likely
   source of an authorization bug. **Decision:** `packages/shared/src/permissions.ts` exports
   the seeded set as a frozen const union, every `config.permission` is typed against it, and
   CI invariant 3 asserts route↔seed equality. `SECURITY.md`'s prose form is non-normative.
2. `RESOLVED` — **Token-epoch naming.** `DATA-MODEL.md` has `app_user.token_epoch` with claim `epc`;
   `SECURITY.md` has `user.token_version` with claim `ver`. This contract uses the column
   `app_user.token_epoch` carried in the claim `ver`. **This pairing is now normative**; the
   other spelling must be edited out of `SECURITY.md`, not carried as an alternative.
3. `RESOLVED` — **Refresh-token TTLs differ.** `SECURITY.md` §3.3: 7-day idle / 14-day absolute (and the
   cookie `Max-Age=604800` agrees). `DATA-MODEL.md` §6.1 column notes: 14-day idle / 30-day
   absolute. **This contract states the `SECURITY.md` values**; the DB column defaults must
   be changed to match, or the tighter value enforced in code and the defaults documented as
   upper bounds. **Decision:** 7-day idle / 14-day absolute is normative; the DB defaults are
   upper bounds and the shorter value is enforced in `refresh_token` issuance.
4. `RESOLVED` — **Session table.** `SECURITY.md` references a `session` table and checks `sid` against it
   on every request; `DATA-MODEL.md` has no such table — the family is
   `refresh_token.family_id`. This contract binds `sid = refresh_token.family_id` and the
   per-request check becomes "a live, unrevoked token exists in this family". If an explicit
   `session` row is wanted (for the Active-sessions screen's `device_label` without scanning
   rotations) it must be added to the data model. **Decision:** no new table. `refresh_token`
   gains `device_label` and `ip_city`, written once on the family's first row and copied on
   rotation, which is what `GET /auth/sessions` reads (§13.1) — one row per family is
   selected by `generation = 0`, so the screen never scans rotations.
5. `RESOLVED` — **Error envelope shape.** `SECURITY.md` shows bare `{"code":…,"message":…}` in its
   examples. This contract mandates the wrapped `{ "error": { … } }` envelope per the product
   directive; read the security doc's snippets as the **inner** object. CI invariant 6 binds
   every declared error response to `ErrorDto`, so a bare-object response cannot ship.
6. `RESOLVED` — **`GET /me/home` is a composite.** It trades REST purity for one round trip on the most
   visited screen. The risk is a single slow block degrading the whole page. Mitigation: each
   block is independently nullable, has its own indexed query, and the handler has a 400 ms
   per-block budget after which that block returns `null` plus
   `partial: ["team"]` — the SPA then lazily refetches that one block from its dedicated
   endpoint.
   **Decision:** ship the composite with the 400 ms per-block budget and the `partial[]`
   field now specified in §13.2; measure in staging against six parallel calls, and if the
   composite's p95 is worse, drop to parallel calls **without** changing any block's shape —
   each block already has a dedicated endpoint, so the migration is a client change only.
7. `OPEN` — **Synchronous policy publication.** `POST /hr/policies/versions/:id/publish` materialises
   assignments inside the transaction so the response can state the real count. At a few
   hundred employees this is milliseconds; beyond ~20 000 it becomes a long transaction. The
   documented escape is to return `202` with a `jobId` and have the HR screen poll — but that
   changes the response contract, so it must be decided before v1, not after.
8. `RESOLVED` — **Synchronous payroll calculation.** `POST /payroll/cycles/:id/calculate` returns `202`
   and is polled. The poll interval, the `payroll_run` lease and what the UI shows on a
   `FAILED` run are specified here; what is **not** specified is the behaviour if the API
   process dies mid-run: `payroll_run` had `status = 'RUNNING'` with no lease column, so the
   run would appear stuck forever.
   **Decision (adopted):** `payroll_run` gains `lease_owner text` and
   `lease_expires_at timestamptz`, renewed every 30 s by the worker, exactly as
   `ess_ops.background_job` already has. A reaper marks a `RUNNING` run whose lease expired
   `FAILED` with `error_message = 'LEASE_EXPIRED'`, moves the cycle back to `VALIDATED`, and
   pages on-call. `GET /payroll/runs/:runId` returns `leaseExpiresAt` so the UI can say
   "still running" rather than spinning forever. Without this a crashed run strands a cycle
   in `CALCULATING`, from which there is no transition.
9. `RESOLVED` — **Idempotency and `4xx` caching.** Storing `4xx` responses against the key means a client
   that fixes its payload but reuses the key gets `422 IDEMPOTENCY_KEY_REUSED` rather than a
   retry. This is deliberate (a changed body with the same key is a client bug) but the SPA
   must mint a fresh key on every user-initiated submit, not once per form mount. Worth a
   lint rule. **Adopted** — the rule and its rationale are now in §8.1.
10. `RESOLVED` — **`GET /me/profile` writes an audit event on read.** A user who idles on the Personal tab
    with a polling refetch will generate `READ_SENSITIVE` volume. Mitigation: the SPA must not
    poll that endpoint, and the handler should coalesce repeat reads by the same actor for the
    same employee within 60 s into one event with a `metadata.repeatCount`. Not yet specified
    in `DATA-MODEL.md` §17.1 — **adopted here**: the mapper coalesces repeat `READ_SENSITIVE`
    events for the same (actor, entity, field-set) within 60 s into one row with
    `metadata.repeatCount`, and the SPA is forbidden from polling `/me/profile`
    (TanStack Query `staleTime: Infinity`, refetch only on explicit user action).
11. `RESOLVED` — **Anonymous tickets and `reply_to`.** An anonymous Town-hall ticket omits
    `reply_to_address`, so the help desk cannot reply in thread. The portal thread remains the
    only channel. HR should be told this explicitly in the queue UI; otherwise anonymous
    tickets look unanswerable. **Resolved in §13.14**: `ui_copy` `ticket.anonymous_notice`
    renders that sentence in the HR queue, and the raiser's identity is stored but projected
    away, so the channel is anonymous to HR without being anonymous to the audit chain.
12. `RESOLVED` — **`WORKFLOWS.md` transition coverage.** §13.19 binds every transition that document
    names to an endpoint, including several this contract did not originally expose
    (`/discard-run`, `/reopen-inputs`, `/scope/:employeeId/defer`, `/policy-versions/:id/{submit-review,return,reassign,withdraw}`,
    `/policy-assignments/:id/waive`, `/tickets/:id/{start,request-info,retry-notification}`,
    `/document-requests/:id/{claim,start}`). **If `WORKFLOWS.md` adds a transition after this
    document is frozen, §13.19 is the file that must change** — CI invariant 3 in Appendix D
    should be extended to assert that every `state_transition` seed row with a non-null
    `required_permission_code` has exactly one route bound to it, so an unexposed transition
    fails the build rather than becoming dead workflow.
13. `RESOLVED` — **`PATCH /me/profile` was deliberately not created**, though `WORKFLOWS.md` mentions it.
    Confirm with the product owner that no profile field is directly self-editable; if one is
    (preferred name is the likely candidate), it needs its own narrow endpoint, its own
    permission and its own audit entry — not a general `PATCH`.
14. `RESOLVED` — **`stepTracker` duplicates workflow knowledge.** It is computed from `status` alone, so it
    cannot drift from the state machine — but its **labels** are a second place the seven
    mandated stages are written down. They must be seeded in `ui_copy` and asserted in CI
    against the `state_transition` table, or a renamed stage will disagree with the workflow.

15. `RESOLVED` — **The invitation flow had no landing route.** `POST /hr/employees/:id/invite`
    created an `app_user` with `password_hash = NULL` and no endpoint existed to set it, so no
    invited employee could ever sign in. `POST /auth/accept-invitation` (§13.1, public,
    token-bound) closes the loop, and `POST /auth/password/forced-change` does the same for
    `403 PASSWORD_CHANGE_REQUIRED`, which previously pointed at a route requiring the very
    session the user could not obtain.
16. `RESOLVED` — **MFA enrolment required a step-up it could not satisfy.** The enrolment
    routes were marked **S** (`mfa_at ≤ 300 s`) while the user's first credential did not yet
    exist. §4.3 now separates `reauth_at` (password) from `mfa_at` (second factor); enrolment
    takes `reauth_at`.
17. `RESOLVED` — **`approval:task:read:any` on the Manager queue was a privilege escalation.**
    `DATA-MODEL.md` §3.3 grants MANAGER `:team`; `:any` is HR-only. §13.15 and the bootstrap
    nav gate now declare `:team`, CI invariant 3c asserts no `/manager/**` route holds an
    `:any` code, and the org-wide view moved to the new HR-only `GET /hr/approvals`.
18. `RESOLVED` — **Published payroll had no lawful correction path.** `cancel` refuses from
    `PUBLISHED`, `payslip` is immutable, yet `payslip_publication.revoked_at`,
    `payslip.revision`, `supersedes_payslip_id` and `payroll:correction:*` all existed with no
    endpoint. §13.6 now specifies `POST /payroll/corrections`, its dual-controlled approval,
    the correction run, and `POST /payroll/publications/:payslipId/revoke`.
19. `RESOLVED` — **Two enum-ordering comparisons would have produced invented numbers.** The
    step tracker's `status ≥` and the Expenses tile's "next cycle with `status <=
'INPUTS_LOCKED'`" are both forbidden by `DATA-MODEL.md` §20.9. The tracker is now explicit
    `IN (…)` lists; the tile now shows a pay date **only** for claims actually queued into a
    batch, which was the fabrication this contract most easily permitted.
20. `RESOLVED` — **`profile_change_request` vs `helpdesk_ticket`.** §13.2 previously created a
    ticket, which would have lost the field-level before/after and let a "resolved" ticket
    leave the profile unchanged. It now creates the `profile_change_request` of
    `DATA-MODEL.md` §5.11, with its own HR queue and its own audited apply.
21. `OPEN` — **Directory search and the `q` predicate.** `full_name || title || department ||
city` with `ILIKE %q%` needs a `pg_trgm` GIN index to stay sub-100 ms at scale, and
    `DATA-MODEL.md` must add it. Until it does, `GET /directory/people` is capped at
    `limit: 25` and 60 requests/min, which bounds the damage. **Owner: data model.**
22. `OPEN` — **`GET /api/v1/version` is readable by every employee.** `gitSha` and
    `payrollEngineVersion` are low-value individually but are free reconnaissance. Default
    until decided: keep `auth:login`, because the SPA shows the build id in the support
    footer and a support ticket without it is harder to trace. **Owner: security review.**
    If narrowed, move it to `org:manage` and have the SPA read only `apiVersion` from a
    public `GET /healthz` extension.
23. `OPEN` — **HR's `audit:read` is scoped by `entity_type` in this contract but not yet in
    `DATA-MODEL.md`'s RLS policy.** §13.17's persona table must be mirrored as an RLS
    predicate, or a direct `psql` session under the HR role would see payroll amounts the API
    withholds. **Owner: data model §17.1.** Until mirrored, the API-level predicate is the
    only control and is asserted by CI invariant 16.
24. `OPEN` — **`ui_copy` coverage is a build dependency, not a runtime one.** Every
    `emptyState`, chip label, `todo` title, `disabledReason` and guard message named in this
    document needs a seeded key before the corresponding screen can ship. The seed list is
    generated from this document by `scripts/extract-ui-copy-keys.ts`; the first run will
    surface keys nobody has written copy for. **Owner: product + People Ops.**
