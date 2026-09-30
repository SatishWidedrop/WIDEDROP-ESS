# Widedrop ESS — Frontend Architecture and Screen Build Spec

**Status:** authoritative design contract for `apps/web`. An implementer follows this
document and makes no further interface decisions.

> ### Canonical reference
>
> **`docs/ARCHITECTURE.md` is the system index and the single source of truth for every
> entity name, enum value, permission string, state name and workflow-stage name.** Where
> this document and any sibling disagree on a _name_, `ARCHITECTURE.md` §4 (Canonical
> glossary) wins and the divergent spelling is a defect to be corrected here. Where they
> disagree on a _control_, the stricter of the two wins and `ARCHITECTURE.md` §4 records
> which that is. No document may introduce a name, enum value or permission code that
> `ARCHITECTURE.md` §4 does not carry.

**Companion documents (read together, no duplication of truth):**

| Document                                                         | Owns                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design/prototype/prototype-markup.html` + `prototype-logic.jsx` | **The UI/UX source of truth.** Layout, order, copy tone, responsive behaviour                                                                                                            |
| `design/DESIGN-SYSTEM.md`                                        | Palette, type scale, geometry, nav model, empty-state pattern, locale                                                                                                                    |
| `docs/ARCHITECTURE.md`                                           | **The index and the tie-breaker.** Canonical glossary of every entity, enum, permission string and state; component diagram; milestones                                                  |
| `docs/API.md`                                                    | The wire: paths, DTOs, statuses, headers, `emptyState` codes, screen→endpoint map                                                                                                        |
| `docs/DATA-MODEL.md`                                             | Tables, enums, state machines, guards                                                                                                                                                    |
| `docs/SECURITY.md`                                               | Auth primitives, RBAC matrix, CSP, masking, headers                                                                                                                                      |
| `docs/WORKFLOWS.md`                                              | State transitions, guards, notifications                                                                                                                                                 |
| **this document**                                                | Folder layout, routing, auth boundary, query/mutation conventions, the component API, responsive implementation, per-screen build spec, empty-state copy, accessibility, client security |

**The eight rules this document never bends:**

1. **No fabricated data.** Every number, count, amount, status, balance and label on screen
   comes from an API response field named here, or from one of the seven shared formatters of
   §2.7 applied to one (`formatInr`, `fmt`, `rel`, …). The SPA owns **no** operational constant. The
   prototype's `PAYSLIPS`, `PROFILE`, `PEOPLE`, `ANN`, `BAL`, `EXP0`, `TK0`, `FAQ`, `APR0`,
   `HOL`, `BENEFITS`, `DOCS`, `LET0`, `TAXQ`, `FORM16`, `POLICIES`, `DEPENDENTS`, `HIS0`,
   `LEAVES0` arrays exist only to define layout; §6 names the replacement source for every
   value in them.
2. **No status→copy mapping in the client.** Chips render `ChipDto.label` with
   `data-tone={ChipDto.tone}`. The SPA never owns a `STATUS_LABELS` map. An unknown enum
   value falls back to `tone="GRAY"` and the raw `label` (`API.md` §1.1).
3. **No `style` attribute, ever.** The shipped DOM must satisfy
   `document.querySelectorAll('[style]').length === 0` (`SECURITY.md` §6.3). All variation is
   a CSS Module class or a `data-*` attribute.
4. **Client authorization is cosmetic.** `can()` hides controls the server would refuse. It
   is never the reason an action is safe. Every gate in §1.2 and §6 is mirrored server-side.
5. **`—` not `0`.** A `null` metric renders an em dash with the persisted explanation from
   `MetricDto.subLabel` / `EmptyStateDto`. Zero is rendered as `0` only when the API sent `0`.
6. **The server clock is the only clock.** Every "is this overdue / open / withdrawable"
   decision is a server-computed boolean (`isOverdue`, `isDeclarationOpen`, `canWithdraw`,
   `isEnabled`), and every relative label is a server string. The SPA calls `Date.now()` in
   exactly two places — the silent-refresh timer and the `429` countdown, neither of which is a
   _displayed datum_. For anything rendered, the clock is `MeDto.serverTime`
   (`API.md` §12.18), re-read on each `GET /me`. An ESLint rule bans `Date.now()` and
   `new Date()` outside `lib/serverTime.ts` and `lib/authSession.ts`.
7. **The client never composes a label.** No pluralisation (`n > 1 ? 's' : ''`), no
   status→word map, no range assembly, no tenure subtraction, no "N open" from a filtered
   array. Counts come from a named response field; plural forms come from the server's
   `ui_copy` pair via `Intl.PluralRules` (`API.md` §12.18 rule 2). The only client-side
   composition permitted anywhere is `formatInr`, `fmt`/`fmtShort`/`fmtLong`/`rel`/`periodRange`
   and `initials` — the _identical_ functions the server uses, imported from
   `@widedrop/shared` and never re-implemented (§2.7).
8. **Every URL here is the canonical path from `API.md` §13.** Where `API.md` marks a path
   "_(canonical; X is not routed)_", this document uses the canonical one. A path that does
   not resolve in `API.md` is a defect in this document, and `apiPaths.contract.test.ts`
   (§9) fails the build on one.

---

## 1. App architecture

### 1.1 Folder layout under `apps/web/src`

```
apps/web/src/
├── main.tsx                          # createRoot; imports styles/*.css in order; no logic
├── app/
│   ├── App.tsx                       # <AppProviders><RouterProvider/></AppProviders>
│   ├── AppProviders.tsx              # QueryClientProvider, AuthProvider, ToastProvider, ShellBreakpointProvider
│   ├── queryClient.ts                # the single QueryClient + defaults (§1.4)
│   ├── router.tsx                    # createBrowserRouter built from routes.tsx
│   ├── routes.tsx                    # the route manifest (§1.2) — the only place a path is written
│   ├── RouteGuard.tsx                # <RequireAuth>, <RequirePermission permission=…>
│   ├── RootErrorBoundary.tsx         # route errorElement → <ErrorState variant="route">
│   └── screenIds.ts                  # ScreenId union + screenId↔path map for deep links (§1.8)
├── routes/                           # one thin route component per screen; no data shapes here
│   ├── home/HomeRoute.tsx
│   ├── payslips/PayslipsRoute.tsx
│   ├── tax/TaxRoute.tsx
│   ├── profile/ProfileRoute.tsx
│   ├── policies/PoliciesRoute.tsx
│   ├── leave/LeaveRoute.tsx
│   ├── benefits/BenefitsRoute.tsx
│   ├── expenses/ExpensesRoute.tsx
│   ├── documents/DocumentsRoute.tsx
│   ├── directory/DirectoryRoute.tsx
│   ├── announcements/AnnouncementsRoute.tsx
│   ├── help/HelpRoute.tsx
│   ├── approvals/ApprovalsRoute.tsx
│   ├── auth/{LoginRoute,MfaChallengeRoute,MfaEnrolRoute,PasswordResetRoute,
│   │        AcceptInvitationRoute,ForcedPasswordChangeRoute}.tsx
│   ├── security/SecurityRoute.tsx    # MFA status, recovery codes, password, sessions (§6.23)
│   ├── approvals/AttendanceSliceRoute.tsx   # a manager's read-only slice (§6.15)
│   ├── NotFoundRoute.tsx
│   ├── hr/{AttendancePeriodsRoute,AttendanceRecordsRoute,EmployeesRoute,EmployeeDetailRoute,
│   │       ChangeRequestQueueRoute,PoliciesAdminRoute,PolicyVersionRoute,PolicyComplianceRoute,
│   │       AnnouncementsAdminRoute,DocumentsAdminRoute,TicketQueueRoute}.tsx
│   ├── accounts/{PayrollCyclesRoute,PayrollCycleRoute,PayrollInputsRoute,ValidationReportRoute,
│   │             PayslipRegisterRoute,ReimbursementsRoute}.tsx
│   └── admin/AuditRoute.tsx
├── features/<module>/                # module = home|payslips|tax|profile|policies|leave|benefits|
│   │                                 #          expenses|documents|directory|announcements|help|
│   │                                 #          approvals|attendance|payroll|employees|audit|auth
│   ├── api.ts                        # typed fetchers over lib/apiClient — the ONLY place a URL string lives
│   ├── queries.ts                    # useXxxQuery hooks + this module's slice of the key factory
│   ├── mutations.ts                  # useXxxMutation hooks + their invalidation set (§1.4.4)
│   ├── schemas.ts                    # re-export of @widedrop/shared schemas + UI-only refinements
│   ├── types.ts                      # DTO types (mirrors docs/API.md §12); no local inventions
│   ├── components/                   # screen-specific composites (e.g. PayslipDetailCard.tsx + .module.css)
│   └── __tests__/
├── components/
│   ├── ui/                           # the primitives of §2.6; one folder each:
│   │   └── Button/{Button.tsx, Button.module.css, Button.test.tsx, index.ts}
│   └── shell/                        # AppShell, Sidebar, NavGroup, NavItem, MobileHeader, TabBar,
│                                     # MoreSheet, GlobalSearch, NotificationPopover, UserCard
├── lib/
│   ├── apiClient.ts                  # fetch wrapper: base URL, auth header, CSRF, 401/403 pipeline, error envelope
│   ├── authSession.ts                # in-memory access token closure + refresh single-flight (§1.3)
│   ├── can.ts                        # cosmetic permission check over me.permissions (§5.4)
│                                     #   — carries the "not a security control" comment
│   ├── serverTime.ts                 # the only clock for displayed values (rule 6)
│   ├── chunkReload.ts                # lazy-chunk 404 after a deploy → one-shot reload (§8.7)
│   ├── queryKeys.ts                  # the key factory (§1.4.1)
│   ├── invalidation.ts               # mutation → keys-to-invalidate map (§1.4.4), unit-tested
│   ├── deepLink.ts                   # NotificationDto.deepLink / search result → router path (§1.8)
│   ├── format.ts                     # re-exports @widedrop/shared formatters; adds no rounding of its own
│   ├── sanitize.ts                   # markdown → safe nodes for policy/announcement bodies (§8.4)
│   ├── download.ts                   # signed-URL download handling (§8.5)
│   ├── errors.ts                     # ApiError class, isApiError, code guards, field-error mapping
│   └── idempotency.ts                # useIdempotencyKey()
├── hooks/
│   ├── useContainerBreakpoints.ts    # the ResizeObserver contract (§3)
│   ├── useAuth.ts  useMe.ts  useBootstrap.ts
│   ├── useToast.ts  useFocusTrap.ts  useRovingTabIndex.ts
│   ├── useDebouncedValue.ts  usePrefersReducedMotion.ts  useStepUp.ts
│   └── useDocumentTitle.ts
├── styles/
│   ├── tokens.css                    # the :root block of §2.2 (already authored — do not fork it)
│   ├── global.css                    # reset, keyframes, focus-visible, scrollbar, body background
│   ├── fonts.css                     # self-hosted IBM Plex @font-face (no Google Fonts at runtime)
│   └── generated/bar-widths.css      # build-generated .bar[data-pct="0..100"] (§2.3)
└── test/
    ├── setup.ts                      # @testing-library/jest-dom, ResizeObserver polyfill stub
    ├── msw/handlers/*.ts             # per-module handlers returning DTO fixtures
    └── render.tsx                    # renderWithProviders(ui, {permissions, route})
```

**Rules that keep this layout honest**

- A URL string appears only in `features/*/api.ts`. A grep for `'/api/v1'` outside
  `features/*/api.ts` and `lib/apiClient.ts` must return nothing; this is a CI check.
- A hex colour appears only in `styles/tokens.css` and `packages/shared/src/design/tokens.ts`.
  CI greps component CSS for `#[0-9a-fA-F]{3,8}` and fails.
- `routes/*` components contain layout composition and hook calls only. Fetching lives in
  `features/*/queries.ts`; no `useQuery({queryFn: …})` inline in a route file.
- Every primitive in `components/ui` is presentational: it takes data and callbacks, never
  calls a query hook, never imports from `features/`.

### 1.2 Routing table

`createBrowserRouter`. One root route owns the shell, so the sidebar, header, tab bar,
search and notification popover mount once and survive navigation (matching the prototype,
where `screen` is state and the chrome never remounts).

`permission` is a `Permission` from `@widedrop/shared` (`packages/shared/src/rbac/roles.ts`).
`<RequirePermission>` renders `<ErrorState variant="forbidden">` rather than redirecting, so
a deep link pasted by a colleague explains itself instead of bouncing.

**Permission strings here are the seeded `permission.code` values of `DATA-MODEL.md` §3.1 —
the same strings `API.md` §13 puts in `config.permission` and `GET /me` returns in
`permissions[]`.** An earlier draft of this document used a third spelling (`profile:read:self`,
`payroll-cycle:read`, `employee:write`, `policy:administer`, `leave:decide`, `payslip:read-any`)
that existed in no seed, no route table and no `state_transition` row; it has been re-keyed
throughout. A `Permission` that `DATA-MODEL.md` §3.1 does not seed is a **compile error**, and
`rbac.contract.test.ts` (§9) diffs `packages/shared`'s union against the seed.

**A permission alone is not a gate — a scope comes with it.** `profile:read:team` is held by a
Manager at `REPORTING_CHAIN` and `employee:read:any` by HR at `ORG`; gating `/hr/employees` on a
bare code would let a Manager mount the HR screen. The guard therefore takes both, and the
"(ORG)" annotations below are enforced, not decorative:

```tsx
interface RequirePermissionProps {
  permission: Permission | Permission[]; // an array is an OR
  scope?: Scope; // default 'SELF'
  children: ReactNode;
}
// passes iff hasPermissionAtScope(me.roles, permission, scope ?? 'SELF')
// evaluated against me.permissions (§5.4), never against a local role guess
```

`can(permission, scope?)` in `lib/can.ts` has the identical signature and the identical
semantics, so a screen control and its route gate cannot disagree. Both are cosmetic; §1.2 and
§6 gates are mirrored server-side by `API.md` §4.1.

| Path                                          | Route component           | `screenId`          | Required permission                                      | Notes                                                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------- | ------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`                                      | `LoginRoute`              | —                   | public                                                   | Outside the shell                                                                                                                                                                                                             |
| `/login/mfa`                                  | `MfaChallengeRoute`       | —                   | public (`mfaToken` in memory)                            | No cookie set yet                                                                                                                                                                                                             |
| `/login/mfa/enrol`                            | `MfaEnrolRoute`           | —                   | public (`mfaToken`, or a session with fresh `reauth_at`) | Forced for `MANAGER`/`HR`/`ACCOUNTS` before `ACTIVE`. Calls `POST /api/v1/auth/mfa/enrol` then `…/verify-enrolment`; both take `reauth_at`, never `mfa_at` (`API.md` §4.3) — a first enrolment has no second factor to assert |
| `/password/reset` · `/password/reset/confirm` | `PasswordResetRoute`      | —                   | public                                                   |                                                                                                                                                                                                                               |
| `/`                                           | `HomeRoute`               | `home`              | `profile:read:self`                                      | Index route                                                                                                                                                                                                                   |
| `/payslips`                                   | `PayslipsRoute`           | `payslips`          | `payslip:read:self`                                      | `?id=` selects the detail                                                                                                                                                                                                     |
| `/tax`                                        | `TaxRoute`                | `tax`               | `tax:quarter:read:self`                                  |                                                                                                                                                                                                                               |
| `/profile`                                    | `ProfileRoute`            | `profile`           | `profile:read:self`                                      | `?tab=personal\|employment\|bank\|emergency`                                                                                                                                                                                  |
| `/policies`                                   | `PoliciesRoute`           | `policies`          | `policy:read`                                            | `?versionId=` selects the detail                                                                                                                                                                                              |
| `/leave`                                      | `LeaveRoute`              | `leave`             | `leave:request:read:self`                                |                                                                                                                                                                                                                               |
| `/benefits`                                   | `BenefitsRoute`           | `benefits`          | `benefit:read:self`                                      |                                                                                                                                                                                                                               |
| `/expenses`                                   | `ExpensesRoute`           | `expenses`          | `expense:claim:read:self`                                | `?new=1` opens the claim form; `?id=` selects a claim                                                                                                                                                                         |
| `/documents`                                  | `DocumentsRoute`          | `documents`         | `document:read:self`                                     |                                                                                                                                                                                                                               |
| `/directory`                                  | `DirectoryRoute`          | `directory`         | `directory:read`                                         | `?q=`, `?person=`, `?page=`                                                                                                                                                                                                   |
| `/announcements`                              | `AnnouncementsRoute`      | `announcements`     | `announcement:read`                                      | `?id=` selects the detail                                                                                                                                                                                                     |
| `/help`                                       | `HelpRoute`               | `help`              | `ticket:read:self`                                       | `?ticketId=` selects the thread                                                                                                                                                                                               |
| `/approvals`                                  | `ApprovalsRoute`          | `approvals`         | `approval:task:read:team`                                | `?tab=pending\|history`, `?kind=`, `?taskId=`                                                                                                                                                                                 |
| `/approvals/attendance/:approvalId`           | `AttendanceSliceRoute`    | `approvals`         | `attendance:approve:team` (REPORTING_CHAIN)              | The manager's **read-only** slice (§6.15). A manager holds no `attendance:capture`, so it must never be routed to `/hr/attendance/:periodId`                                                                                  |
| `/security`                                   | `SecurityRoute`           | `security`          | `profile:read:self` (SELF)                               | MFA, recovery codes, password, sessions (§6.23)                                                                                                                                                                               |
| `/hr/attendance`                              | `AttendancePeriodsRoute`  | `hrAttendance`      | `attendance:submit` (ORG)                                |                                                                                                                                                                                                                               |
| `/hr/attendance/:periodId`                    | `AttendanceRecordsRoute`  | `hrAttendance`      | `attendance:capture` (ORG)                               | The HR capture grid. **HR only** — see `/approvals/attendance/:approvalId` for managers                                                                                                                                       |
| `/hr/employees`                               | `EmployeesRoute`          | `hrEmployees`       | `employee:read:any` (ORG)                                | `employee:read:any` — a code **no Manager holds** (§3.3: a Manager holds no `:read:any` code of any kind), which is what keeps this screen HR-only; this matches `NAV_MANIFEST` (§5.1)                                        |
| `/hr/employees/:employeeId`                   | `EmployeeDetailRoute`     | `hrEmployees`       | `employee:read:any` (ORG)                                |                                                                                                                                                                                                                               |
| `/hr/profile-change-requests`                 | `ChangeRequestQueueRoute` | `hrChangeRequests`  | `profile:change_request:read:any` (ORG)                  | Claim / approve / reject queue (§6.16)                                                                                                                                                                                        |
| `/hr/policies`                                | `PoliciesAdminRoute`      | `hrPolicies`        | `policy:author` (ORG)                                    |                                                                                                                                                                                                                               |
| `/hr/policies/:policyId/versions/:versionId`  | `PolicyVersionRoute`      | `hrPolicies`        | `policy:author` (ORG)                                    | Draft editor + publish                                                                                                                                                                                                        |
| `/hr/policies/versions/:versionId/compliance` | `PolicyComplianceRoute`   | `hrPolicies`        | `policy:ack:read:any` (ORG)                              |                                                                                                                                                                                                                               |
| `/hr/announcements`                           | `AnnouncementsAdminRoute` | `hrAnnouncements`   | `announcement:author` (ORG)                              |                                                                                                                                                                                                                               |
| `/hr/documents`                               | `DocumentsAdminRoute`     | `hrDocuments`       | `document:request:read:any` (ORG)                        | Letter request queue + upload                                                                                                                                                                                                 |
| `/hr/tickets`                                 | `TicketQueueRoute`        | `hrTickets`         | `ticket:read:any` (ORG)                                  |                                                                                                                                                                                                                               |
| `/accounts/payroll`                           | `PayrollCyclesRoute`      | `payrollCycles`     | `payroll:cycle:read` (ORG)                               |                                                                                                                                                                                                                               |
| `/accounts/payroll/:cycleId`                  | `PayrollCycleRoute`       | `payrollCycles`     | `payroll:cycle:read` (ORG)                               | Step tracker hub                                                                                                                                                                                                              |
| `/accounts/payroll/:cycleId/inputs`           | `PayrollInputsRoute`      | `payrollInputs`     | `payroll:input:read` (ORG)                               |                                                                                                                                                                                                                               |
| `/accounts/payroll/:cycleId/validation`       | `ValidationReportRoute`   | `payrollValidation` | `payroll:validation_issue:read` (ORG)                    |                                                                                                                                                                                                                               |
| `/accounts/payroll/:cycleId/register`         | `PayslipRegisterRoute`    | `payrollRegister`   | `payslip:read:any` (ORG)                                 |                                                                                                                                                                                                                               |
| `/accounts/reimbursements`                    | `ReimbursementsRoute`     | `reimbursements`    | `expense:reimburse`                                      |                                                                                                                                                                                                                               |
| `/audit`                                      | `AuditRoute`              | `audit`             | `audit:read` (ORG)                                       | HR + Accounts                                                                                                                                                                                                                 |
| `*`                                           | `NotFoundRoute`           | —                   | authenticated                                            | `<EmptyState>`-styled 404 inside the shell                                                                                                                                                                                    |

**Unauthenticated routes sit outside the shell and outside `<RequireAuth>`:** `/login`,
`/login/mfa`, `/login/mfa/enrol`, `/password/reset`, `/password/reset/confirm`,
`/invitation/accept`, `/password/forced-change`. Their specs are §6.22. Each renders the org
wordmark from the **bundled** asset only — an unauthenticated page makes no API call that
could leak whether an account exists.

**Query-parameter discipline.** Selection state that the prototype held in component state
(`payslip`, `policy`, `ann`, `person`, `ptab`, `apprTab`, `efOpen`, `dirQ`) becomes a search
param, so every selection is linkable, back-button-correct, and reachable from a
notification deep link. Search params are parsed through a per-route Zod schema; an invalid
value falls back to the default rather than throwing.

**Default selection writes the URL with `replace`.** Where a split screen selects the first
row because no id was given (Payslips, Policies, Announcements), it calls
`setSearchParams(next, { replace: true })` inside an effect, so the back button leaves the
screen rather than cycling through auto-selections. The detail query stays
`enabled: !!id`, and the list's `emptyState` — not a spinner — is what renders when there is
no first row to select.

**Route-level code splitting.** `lazy()` per route group: the employee bundle never contains
the HR or Accounts route code. Combined with §1.2's permission gate this means a user without
`payroll:cycle:read` does not download the payroll screens at all.

### 1.3 The auth boundary

Implemented in `lib/authSession.ts` + `lib/apiClient.ts` + `hooks/useAuth.ts`.

**Where the credentials live**

| Credential                      | Where                                                                                                                                                                                                                                                                                      | Never                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access token (600 s, EdDSA JWT) | A module-scope `let` inside the `authSession` closure. Exposed only as `getAccessToken()` / `setAccessToken()`.                                                                                                                                                                            | `localStorage`, `sessionStorage`, IndexedDB, a cookie, React state, a query cache entry, a Redux-like store, a URL                                                   |
| Refresh token                   | `__Host-wd_rt` cookie, `HttpOnly` — **the SPA cannot read it and never tries**                                                                                                                                                                                                             | Any JS access                                                                                                                                                        |
| CSRF token (`<nonce>.<hmac>`)   | The **JSON response body** of `POST /api/v1/auth/login` (final step), `/auth/mfa/challenge`, `/auth/mfa/step-up` and `/auth/refresh`, held in the same `authSession` closure as the access token and sent as `X-WD-CSRF` on **every unsafe method except `/auth/refresh`** (`API.md` §1.3) | `document.cookie` — the `__Host-wd_csrf` cookie is `HttpOnly` and is set on `api-ess.widedrop.com`, so the SPA on `ess.widedrop.com` cannot read it and must not try |
| Identity for display            | `GET /me`, cached by TanStack Query                                                                                                                                                                                                                                                        | Decoding the JWT. `apiClient` must not import a JWT library                                                                                                          |
| The displayed clock             | `MeDto.serverTime`, captured with `performance.now()` at receipt and advanced monotonically by `lib/serverTime.ts`                                                                                                                                                                         | `Date.now()` / `new Date()` (rule 6)                                                                                                                                 |

> **Correction, and the reason for it.** Earlier drafts of this document — and `API.md` §1.3
> and §4.2 — describe `__Host-wd_csrf` as a _readable_ cookie echoed in a classic
> double-submit, required on three routes. That is **not implementable in this topology and is
> not the design**: a `__Host-` cookie carries no `Domain`, so it is host-locked to
> `api-ess.widedrop.com`, while `document.cookie` is scoped to the _document's_ host,
> `ess.widedrop.com`. `SECURITY.md` §3.4/§3.5 carries the authoritative correction and this
> document follows it. Two consequences the implementer must not get backwards:
>
> 1. **`X-WD-CSRF` goes on every `POST`/`PUT`/`PATCH`/`DELETE`**, not on three routes.
>    `apiClient` attaches it from the closure for all unsafe methods, with no per-call opt-in.
> 2. **`POST /auth/refresh` is the one unsafe route that is exempt**, because on a cold load
>    the SPA has no token yet (`SECURITY.md` §3.5 clause 2). It is protected instead by
>    `Origin` + the three mandatory `Sec-Fetch-*` headers + `__Host-` + `SameSite=Strict` +
>    rotation-with-reuse-detection. The SPA sends `X-WD-CSRF` on `/auth/refresh` anyway when it
>    holds one (a warm refresh); the server accepts either.
>
> The CSRF token rotates on every login, step-up and refresh. `setCsrfToken()` is called from
> the same code path as `setAccessToken()`, never separately, so the two can never be from
> different sessions. On `hardLogout` both are cleared.

The token is deliberately not React state: state lands in React DevTools and in error-reporting
snapshots. Components that need "am I signed in" read `useAuth().status`, which is derived
from a boolean the closure publishes through a subscription, not from the token itself.

**Cold start sequence** (`AuthProvider` mount)

1. `POST /auth/refresh` with `credentials: 'include'` and **no** `X-WD-CSRF` (there is none
   yet — see the correction above).
2. `200` → `setAccessToken(accessToken)`, `setCsrfToken(csrfToken)`, schedule the silent
   refresh, `status='authenticated'`. Then fire `GET /me` and `GET /me/bootstrap` **in
   parallel**; the shell renders its skeleton until both resolve. `GET /me`'s `serverTime` is
   handed to `lib/serverTime.ts` before the first render, so nothing ever paints against an
   unseeded clock.
3. `401` (no cookie, expired family, revoked, reuse detected) → `status='anonymous'`,
   redirect to `/login?next=<encodeURIComponent(location.pathname+search)>`. No error toast:
   an expired session is normal, not a failure.
4. Network error / `503` → `status='error'`, render `<ErrorState variant="offline">` with a
   Retry button. **Do not** treat a network failure as a logout; that would discard an
   otherwise valid session.
5. `403 PASSWORD_CHANGE_REQUIRED` → `status='anonymous'`, navigate to `/password/forced-change`
   carrying `details.changeToken` **in memory only** (§6.22.5). The token is never placed in
   the URL, `sessionStorage` or the query cache.
6. `403 MFA_ENROLMENT_REQUIRED` → `/login/mfa/enrol` with the `enrolmentToken` held the same
   way.

**Silent refresh.** A timer scheduled at `expiresIn - 60 s` (i.e. ~540 s) calls
`POST /auth/refresh`. The timer is cleared on logout and rescheduled on every successful
refresh. The tab also refreshes on `visibilitychange → visible` when the token has less than
60 s left, because background tabs throttle timers.

**Session lifetime, explicitly.** The refresh family lives 7 days (`SECURITY.md` §3.4). The
SPA adds two of its own bounds, because a payslip left open on a shared desk is the realistic
threat:

| Bound                   | Behaviour                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Idle 30 min**         | No pointer, key, or successful request for 30 min ⇒ a `Modal dismissible={false}` warns at 28 min with a countdown; at 30 min `hardLogout('idle')`. The timer is reset by real interaction, not by the polling `notifications.unread` query |
| **Backgrounded 60 min** | `visibilitychange → visible` after ≥ 60 min hidden ⇒ `queryClient.clear()` then refetch, so no stale salary figure is repainted before the server confirms it. (The previous "12 h" figure was arbitrary and is withdrawn.)                 |

**The 401 pipeline** (`apiClient`, one implementation, no per-call handling)

```
request → 401 ?
  ├── error.code === 'SESSION_REVOKED'  → hardLogout('revoked')            // never retry
  ├── already retried once for this request → hardLogout('expired')
  └── else → await refreshOnce() ─ 200 → replay the original request once
                                 └ 401 → hardLogout('expired')
```

`refreshOnce()` is **single-flight**: concurrent 401s await one shared promise, so a screen
firing six queries does not fire six refreshes (each of which would rotate the family and trip
reuse detection). Requests that arrive while a refresh is in flight queue on the same promise.

**`hardLogout(reason)`** — `clearAccessToken()`, `clearCsrfToken()`, cancel the refresh and idle timers,
`queryClient.cancelQueries()` then `queryClient.clear()` (the cache holds salary and PII;
it must not survive a session), `navigate('/login?reason=' + reason)`. `POST /auth/logout` is
sent best-effort first when the reason is a user-initiated sign-out; clearing the client alone
is never treated as logout (`API.md` §13.1). The destination preserves where the user was —
`/login?reason=<reason>&next=<encodeURIComponent(pathname+search)>` — with `next` omitted when
`reason === 'revoked'` (a revoked session should not hint at what it was reading) and validated
by the open-redirect rule of §8.6 on the way back in.

**The 403 step-up pipeline.** `403` with `code === 'MFA_STEP_UP_REQUIRED'` rejects into
`useStepUp()`, which opens `<StepUpDialog>` (a `Modal`), calls `POST /auth/mfa/step-up`,
stores the fresh access token and replays the original request **once**. A cancelled dialog
rejects the original promise with a typed `StepUpCancelled` error that mutations translate
into a dismissible inline banner, not a toast. Screens needing step-up: bank/statutory change
requests, unmask, payroll approve/publish, any export, role grants.

**The 403 re-auth pipeline** is its own thing and is not interchangeable with step-up.
`403` with `code === 'REAUTH_REQUIRED'` opens `<ReauthDialog>` — a password prompt, not an OTP
prompt — calling `POST /auth/reauth {password}`; it guards MFA enrolment, MFA verify-enrolment,
recovery-code regeneration, credential deletion, and (in addition to `mfa_at`)
`POST /auth/password/change` (`API.md` §4.3). `useStepUp()` and `useReauth()` share one
single-flight queue so two concurrent 403s raise one dialog, and both replay the original
request **once**. Neither dialog is dismissible by scrim click; both are dismissible by
`Escape`, which rejects with `StepUpCancelled` / `ReauthCancelled`.

**Other statuses**, handled centrally so no screen re-implements them:

| Status / code               | `apiClient` behaviour                                                                                                                                                                                                                             | Screen behaviour                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403 AUTHZ_DENIED`          | reject                                                                                                                                                                                                                                            | `<ErrorState variant="forbidden">`; the control is also hidden by `can()` next render                                                                                                                                                                                                                                |
| `404`                       | reject                                                                                                                                                                                                                                            | `<ErrorState variant="notFound">` — never "0 results"                                                                                                                                                                                                                                                                |
| `409 VERSION_CONFLICT`      | reject                                                                                                                                                                                                                                            | Inline banner "This changed while you were reading it." + auto-refetch of the entity                                                                                                                                                                                                                                 |
| `409 GUARD_FAILED`          | reject, expose `details.guardKey`                                                                                                                                                                                                                 | Inline banner with the server `message` (it names the blocking step)                                                                                                                                                                                                                                                 |
| `422 *`                     | reject, expose `details.fieldErrors`                                                                                                                                                                                                              | `setError()` per field + `FormCard errorBanner`                                                                                                                                                                                                                                                                      |
| `423 ACCOUNT_LOCKED`        | reject                                                                                                                                                                                                                                            | Login screen only; shows `Retry-After`                                                                                                                                                                                                                                                                               |
| `428 PRECONDITION_REQUIRED` | reject                                                                                                                                                                                                                                            | A bug: the request omitted a required `If-Match`. Log it with `requestId`, refetch the entity, and render the `409 VERSION_CONFLICT` banner. **A write is never auto-replayed here** — replaying a mutation against a version the user has not seen is exactly the lost update the precondition exists to stop       |
| `429`                       | reject, read `Retry-After`                                                                                                                                                                                                                        | Disable the submit control for that many seconds with a countdown                                                                                                                                                                                                                                                    |
| `5xx`                       | **`GET`/`HEAD` only**: retry twice with backoff (250 ms, 1 s, full jitter), then reject. An unsafe method is **never** retried by `apiClient` — a `502` can mean the write landed. The user retries, and `Idempotency-Key` makes that replay safe | `<ErrorState variant="server">` showing `requestId` as the support reference                                                                                                                                                                                                                                         |
| `503` + `Retry-After`       | reject; never retried                                                                                                                                                                                                                             | `<ErrorState variant="offline">` with maintenance copy and the countdown                                                                                                                                                                                                                                             |
| chunk load failure          | n/a — a hashed `<script>` 404s after a deploy                                                                                                                                                                                                     | `lib/chunkReload.ts`: on `ChunkLoadError` or a failed dynamic import, `location.reload()` **once** per tab, guarded by a `window.name` sentinel (not storage, which may be blocked). A second failure renders `<ErrorState variant="server">` with "A new version was released — please reload", never a reload loop |

**Every request** carries `X-Request-Id: crypto.randomUUID()`, `Accept: application/json`, and
`Origin` (set by the browser; the SPA never forges it). Every **unsafe** method additionally
carries `X-WD-CSRF` from the session closure, and `Idempotency-Key` where `API.md` §9 marks the
endpoint **I** (§1.5).

`credentials: 'include'` is sent on **`/auth/*` and nowhere else**. That is the exact set of
routes that mint, rotate or destroy the `__Host-wd_rt` / `__Host-wd_csrf` cookies —
`login`, `mfa/challenge`, `mfa/verify`, `mfa/step-up`, `refresh`, `logout`, `logout-all`,
`reauth`, `accept-invitation`, `password/forced-change`, `password-reset/confirm`,
`password/change`. Every other route is `credentials: 'omit'`, so a business endpoint can never
be authenticated by a cookie and is therefore structurally immune to CSRF regardless of the
token. (The earlier "only the three cookie routes" rule was wrong in the other direction:
`fetch` will not _store_ a `Set-Cookie` from a cross-origin response without
`credentials: 'include'`, so login would silently never establish a session.)

`apiClient` sets no `Content-Type` on a `GET`, sends `application/json` on a JSON body, and
lets the browser set the multipart boundary on `POST /api/v1/files`. It does **not** follow
redirects for downloads — see §8.5.

### 1.4 TanStack Query conventions

#### 1.4.1 The key factory — `lib/queryKeys.ts`

One exported object. No literal array key anywhere else; `no-restricted-syntax` forbids
`useQuery({queryKey: [`.

```ts
export const qk = {
  me: () => ['me'] as const,
  bootstrap: () => ['me', 'bootstrap'] as const,
  home: () => ['me', 'home'] as const,
  notifications: {
    list: (p: { unreadOnly?: boolean } = {}) => ['notifications', 'list', p] as const,
    unread: () => ['notifications', 'unread'] as const,
  },
  search: (q: string) => ['search', q] as const,

  payslips: {
    list: (p: { fiscalYearId?: string; page: number }) => ['payslips', 'list', p] as const,
    detail: (id: string) => ['payslips', 'detail', id] as const,
  },
  tax: {
    summary: (fy?: string) => ['tax', 'summary', fy ?? 'current'] as const,
    quarters: (fy?: string) => ['tax', 'quarters', fy ?? 'current'] as const,
    form16: (p: { page: number }) => ['tax', 'form16', p] as const,
    declaration: (fy?: string) => ['tax', 'declaration', fy ?? 'current'] as const,
  },
  profile: {
    tab: (tab: ProfileTab) => ['profile', 'tab', tab] as const,
    emergencyContacts: () => ['profile', 'emergency-contacts'] as const,
    changeRequests: (p: { page: number }) => ['profile', 'change-requests', p] as const,
  },
  security: {
    mfaStatus: () => ['security', 'mfa-status'] as const,
    sessions: () => ['security', 'sessions'] as const,
  },
  policies: {
    list: (p: { page: number }) => ['policies', 'list', p] as const,
    detail: (versionId: string) => ['policies', 'detail', versionId] as const,
  },
  leave: {
    types: () => ['leave', 'types'] as const,
    balances: () => ['leave', 'balances'] as const,
    requests: (p: { status?: string; cursor?: string }) => ['leave', 'requests', p] as const,
    holidays: (p: { from?: string; to?: string }) => ['leave', 'holidays', p] as const,
  },
  benefits: {
    list: () => ['benefits', 'list'] as const,
    dependents: (p: { page: number }) => ['benefits', 'dependents', p] as const,
  },
  expenses: {
    categories: () => ['expenses', 'categories'] as const,
    claims: (p: { status?: string; cursor?: string }) => ['expenses', 'claims', p] as const,
    claim: (id: string) => ['expenses', 'claim', id] as const,
  },
  documents: {
    templates: () => ['documents', 'templates'] as const,
    requests: (p: { page: number }) => ['documents', 'requests', p] as const,
    list: (p: { cursor?: string }) => ['documents', 'list', p] as const,
  },
  directory: {
    people: (p: { q?: string; page: number }) => ['directory', 'people', p] as const,
    person: (id: string) => ['directory', 'person', id] as const,
    reportingLine: () => ['directory', 'reporting-line'] as const,
  },
  announcements: {
    list: (p: { cursor?: string }) => ['announcements', 'list', p] as const,
    detail: (id: string) => ['announcements', 'detail', id] as const,
  },
  help: {
    categories: () => ['help', 'categories'] as const,
    faq: () => ['help', 'faq'] as const,
    tickets: (p: { cursor?: string }) => ['help', 'tickets', p] as const,
    ticket: (id: string) => ['help', 'ticket', id] as const,
  },
  approvals: {
    pending: (p: { kind?: string; page: number }) => ['approvals', 'pending', p] as const,
    history: (p: { cursor?: string }) => ['approvals', 'history', p] as const,
    teamCalendar: (p: { from: string; to: string }) => ['approvals', 'team-calendar', p] as const,
  },
  attendance: {
    periods: (p: { page: number }) => ['attendance', 'periods', p] as const,
    period: (id: string) => ['attendance', 'period', id] as const,
    records: (periodId: string, p: object) => ['attendance', 'records', periodId, p] as const,
    myRecord: (periodId?: string) => ['attendance', 'mine', periodId ?? 'latest'] as const,
    approvals: (p: { page: number }) => ['attendance', 'approvals', p] as const,
    approvalRecords: (id: string, p: object) => ['attendance', 'approval-records', id, p] as const,
  },
  payroll: {
    cycles: (p: { status?: string; page: number }) => ['payroll', 'cycles', p] as const,
    cycle: (id: string) => ['payroll', 'cycle', id] as const,
    batches: (cycleId: string) => ['payroll', 'batches', cycleId] as const,
    batchItems: (batchId: string, p: object) => ['payroll', 'batch-items', batchId, p] as const,
    validation: (cycleId: string, p: object) => ['payroll', 'validation', cycleId, p] as const,
    run: (runId: string) => ['payroll', 'run', runId] as const,
    register: (cycleId: string, p: object) => ['payroll', 'register', cycleId, p] as const,
    reimbursements: (p: object) => ['payroll', 'reimbursements', p] as const,
  },
  hr: {
    employees: (p: object) => ['hr', 'employees', p] as const,
    employee: (id: string) => ['hr', 'employee', id] as const,
    policies: (p: object) => ['hr', 'policies', p] as const,
    policyCompliance: (versionId: string, p: object) =>
      ['hr', 'policy-compliance', versionId, p] as const,
    announcements: (p: object) => ['hr', 'announcements', p] as const,
    documentRequests: (p: object) => ['hr', 'document-requests', p] as const,
    tickets: (p: object) => ['hr', 'tickets', p] as const,
    ticket: (id: string) => ['hr', 'ticket', id] as const,
    profileChangeRequests: (p: object) => ['hr', 'profile-change-requests', p] as const,
    policyVersion: (id: string) => ['hr', 'policy-version', id] as const,
  },
  audit: {
    list: (p: object) => ['audit', 'list', p] as const,
    chain: () => ['audit', 'chain'] as const,
  },
} as const;
```

Prefix invalidation is the norm: `invalidateQueries({queryKey: ['leave']})` covers balances,
requests and holidays in one call.

Two structural rules make the factory safe to extend:

- **Every key's first segment is a module name** and every module in §1.1's list has exactly
  one branch here. `queryKeys.contract.test.ts` asserts the set of first segments equals the
  module list, so a new module cannot ship with ad-hoc keys.
- **A parameter object in a key is the same object that is serialised into the query string.**
  The fetcher derives the URL from it; there is no second place where `page`/`cursor`/`q` are
  spelled. A key that omits a parameter the request sends is a cache-poisoning bug, and the
  contract test compares the two by construction.

#### 1.4.2 Defaults (`app/queryClient.ts`)

```ts
defaultOptions: {
  queries: {
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: true,
    retry: (failureCount, err) =>
      isApiError(err) && err.status < 500 ? false : failureCount < 2,   // never retry 4xx
    retryDelay: (n) => Math.min(1000 * 2 ** n, 8000),
    throwOnError: false,                 // screens render <ErrorState>, boundaries catch only render bugs
  },
  mutations: { retry: false },           // a write is never retried automatically; Idempotency-Key exists for the user's retry
}
```

#### 1.4.3 Staleness tiers (override per hook)

| Tier                  | `staleTime`                                                                                                                                                                                                               | `refetchOnWindowFocus` | Members                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Reference**         | `30 * 60_000`                                                                                                                                                                                                             | `false`                | `leave.types`, `expenses.categories`, `documents.templates`, `help.categories`, `help.faq`, `leave.holidays` |
| **Identity / shell**  | `5 * 60_000`                                                                                                                                                                                                              | `false`                | `me`, `bootstrap`                                                                                            |
| **Own records**       | `30_000`                                                                                                                                                                                                                  | `'always'`             | payslips, tax, policies, leave requests, expenses, documents, benefits, profile                              |
| **Others' work**      | `15_000`                                                                                                                                                                                                                  | `'always'`             | `approvals.*`, `attendance.approvals`, `hr.tickets`, `hr.documentRequests`                                   |
| **Counters**          | `60_000` + `refetchInterval: 60_000` (paused when the tab is hidden)                                                                                                                                                      | `'always'`             | `notifications.unread`                                                                                       |
| **In-flight process** | `0` + `refetchInterval: 5_000` while `status ∈ {VALIDATING, CALCULATING}` or `run.status === 'RUNNING'`; interval returns `false` otherwise, **and unconditionally after 15 minutes or 180 polls**, whichever comes first | `'always'`             | `payroll.cycle`, `payroll.run`                                                                               |
| **Search**            | `10_000`, `enabled: q.length >= 2`, 250 ms debounce, `placeholderData: keepPreviousData`                                                                                                                                  | `false`                | `search`, `directory.people`                                                                                 |

When the poll gives up, the screen renders an inline `<ErrorState variant="server">` reading
"This run has been going for longer than expected" with a Retry that restarts the poll — a
cycle wedged in `CALCULATING` must not spin a browser tab for a working day.

`notifications.unread` is the only polled employee-facing query; everything else refreshes on
focus. There is no websocket in v1.

**One unread count, one source.** `bootstrap.badges.notificationsUnread` and
`GET /me/notifications/unread-count` are the same number computed by the same query
(`API.md` §13.2). The shell renders the **dot** from `qk.notifications.unread()` because that
is the one that polls; `qk.bootstrap()` is never read for it. Every mutation that can change
it invalidates both keys together (§1.4.4) so the two can never be seen disagreeing. The same
rule binds `bootstrap.badges.approvals` to `GET /manager/approvals`.`page.total`: the sidebar
badge reads `bootstrap`, the tab count reads `page.total`, and `/manager/approvals/:id/decide`
invalidates both in one call.

#### 1.4.4 The invalidation map (`lib/invalidation.ts`)

Every mutation declares its effect. A mutation that returns the canonical entity writes it with
`setQueryData` **and** invalidates the sibling lists — the write is a cache prime, never a
substitute for the server's list re-read (counts and rollups are server-computed).

| Mutation                                                                       | `setQueryData`                                                                                     | Invalidate                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /me/leave-requests`                                                      | `qk.leave.requests` first page prepend via invalidate (no manual splice)                           | `['leave']`, `qk.home()`, `qk.bootstrap()`, `qk.notifications.unread()`                                                                                                                                                |
| `POST /me/leave-requests/:id/withdraw`                                         | `qk.leave.requests` entry                                                                          | `['leave']`, `qk.home()`, `qk.bootstrap()`                                                                                                                                                                             |
| `POST /me/expense-claims`                                                      | `qk.expenses.claim(id)`                                                                            | `['expenses']`, `qk.home()`                                                                                                                                                                                            |
| `POST /me/expense-claims/:id/withdraw`                                         | `qk.expenses.claim(id)`                                                                            | `['expenses']`                                                                                                                                                                                                         |
| `POST /me/policy-versions/:versionId/acknowledge`                              | `qk.policies.detail(versionId)`                                                                    | `qk.policies.list`, `qk.home()`, `qk.bootstrap()` (the `policiesPending` badge)                                                                                                                                        |
| `POST /me/tickets`                                                             | `qk.help.ticket(id)`                                                                               | `qk.help.tickets`, `qk.home()`                                                                                                                                                                                         |
| `POST /me/tickets/:id/comments` · `…/close` · `…/reopen`                       | `qk.help.ticket(id)`                                                                               | `qk.help.tickets`                                                                                                                                                                                                      |
| `POST /me/document-requests`                                                   | —                                                                                                  | `qk.documents.requests`, `qk.home()`                                                                                                                                                                                   |
| `POST /me/profile-change-requests`                                             | —                                                                                                  | `qk.profile.changeRequests`, `qk.profile.tab(tab)`, `qk.home()` — **not** `qk.help.tickets`: `API.md` §13.2 creates a `profile_change_request`, **not** a `helpdesk_ticket`                                            |
| `POST /me/emergency-contacts` · `PATCH` · `DELETE`                             | —                                                                                                  | `qk.profile.emergencyContacts()`, `qk.profile.tab('emergency')`                                                                                                                                                        |
| `PUT /me/tax/declaration` · `/submit` · `/proofs`                              | `qk.tax.declaration()`                                                                             | `qk.tax.summary()`, `qk.tax.quarters()`                                                                                                                                                                                |
| `POST /me/dependents` · `PATCH` · `DELETE`                                     | —                                                                                                  | `['benefits']`                                                                                                                                                                                                         |
| `POST /me/benefits/:planYearId/enrol`                                          | —                                                                                                  | `['benefits']`, `qk.home()`                                                                                                                                                                                            |
| `POST /me/payslips/:id/email`                                                  | —                                                                                                  | none (fire-and-forget; toast from the response)                                                                                                                                                                        |
| `POST /me/announcements/:id/read`                                              | `qk.announcements.detail(id)` → `isRead: true` (optimistic, rollback on error)                     | `qk.announcements.list` (silent)                                                                                                                                                                                       |
| `POST /me/notifications/read`                                                  | `qk.notifications.unread()` from the response's `unreadCount`                                      | `qk.notifications.list`, `qk.bootstrap()`                                                                                                                                                                              |
| `POST /me/notifications/:id/dismiss` (`204`)                                   | —                                                                                                  | `qk.notifications.list`, `qk.notifications.unread()`, `qk.bootstrap()`                                                                                                                                                 |
| `POST /me/expense-claims/:id/attachments` · `DELETE …`                         | `qk.expenses.claim(id)`                                                                            | `['expenses']`                                                                                                                                                                                                         |
| `POST /me/tickets/:id/attachments`                                             | `qk.help.ticket(id)`                                                                               | `qk.help.tickets`                                                                                                                                                                                                      |
| `POST /api/v1/files`                                                           | —                                                                                                  | none — a `file_object` is not attached by this call and owns no list                                                                                                                                                   |
| `POST /manager/approvals/:id/decide`                                           | `qk.approvals.pending` (remove the row), `qk.bootstrap()` badge from the response's `pendingCount` | `['approvals']`, `['leave']`, `['expenses']`, `['attendance']`, `qk.home()`                                                                                                                                            |
| `PUT /hr/attendance/periods/:id/records/:employeeId`                           | that row in `qk.attendance.records`                                                                | `qk.attendance.period(id)` (control totals)                                                                                                                                                                            |
| `POST /hr/attendance/periods/:id/reopen`                                       | `qk.attendance.period(id)`                                                                         | `['attendance']`, `['payroll']`, `qk.bootstrap()`                                                                                                                                                                      |
| `POST /hr/attendance/approvals/:id/escalate`                                   | —                                                                                                  | `['attendance']`, `['approvals']`, `qk.bootstrap()`                                                                                                                                                                    |
| `POST /hr/attendance/periods/:id/records:bulk`                                 | —                                                                                                  | `['attendance']`                                                                                                                                                                                                       |
| `POST /hr/attendance/periods/:id/submit`                                       | `qk.attendance.period(id)`                                                                         | `['attendance']`, `['payroll']`, `qk.bootstrap()`                                                                                                                                                                      |
| `POST /manager/attendance/approvals/:id/decide`                                | —                                                                                                  | `['attendance']`, `['approvals']`, `['payroll']`, `qk.bootstrap()`                                                                                                                                                     |
| `POST /payroll/cycles/:id/<verb>` (every transition)                           | `qk.payroll.cycle(id)` from the response                                                           | `['payroll']`, `['attendance']`, `qk.bootstrap()`                                                                                                                                                                      |
| `POST /payroll/cycles/:id/publish`                                             | `qk.payroll.cycle(id)`                                                                             | `['payroll']`, and **nothing employee-side** — the publisher is not the employee; employees see it on their next fetch                                                                                                 |
| `POST /hr/policies` · `POST /hr/policies/:id/versions`                         | `qk.hr.policyVersion(id)`                                                                          | `['hr','policies']`                                                                                                                                                                                                    |
| `PATCH /hr/policies/versions/:id` (DRAFT only)                                 | `qk.hr.policyVersion(id)`                                                                          | `['hr','policies']`                                                                                                                                                                                                    |
| `POST /hr/policy-versions/:id/{submit-review,return,reassign,withdraw}`        | `qk.hr.policyVersion(id)`                                                                          | `['hr','policies']`, `qk.bootstrap()`                                                                                                                                                                                  |
| `POST /hr/policy-versions/:id/publish`                                         | `qk.hr.policyVersion(id)`                                                                          | `['hr','policies']`, `['policies']`, `qk.hr.policyCompliance(id, {})`                                                                                                                                                  |
| `POST /hr/policy-assignments/:id/waive`                                        | —                                                                                                  | `['hr','policies']`, `['policies']`                                                                                                                                                                                    |
| `POST /hr/profile-change-requests/:id/{claim,approve,reject}`                  | that row in `qk.hr.profileChangeRequests`                                                          | `['hr','profile-change-requests']`, `qk.bootstrap()`                                                                                                                                                                   |
| `POST /hr/announcements/:id/publish` · `/pin` · `/archive`                     | —                                                                                                  | `['hr','announcements']`, `['announcements']`                                                                                                                                                                          |
| `POST /hr/tickets/:id/{assign,comments,resolve}`                               | `qk.hr.tickets` row                                                                                | `['hr','tickets']`                                                                                                                                                                                                     |
| `POST /hr/document-requests/:id/issue` · `/reject`                             | —                                                                                                  | `['hr','document-requests']`                                                                                                                                                                                           |
| `POST /hr/employees` · `PATCH /hr/employees/:id` · `/invite` · `/deactivate`   | `qk.hr.employee(id)`                                                                               | `['hr','employees']`, `qk.directory.people`                                                                                                                                                                            |
| `POST /payroll/cycles/:id/input-batches` · `/commit` · `DELETE`                | `qk.payroll.batchItems(batchId, {})`                                                               | `qk.payroll.batches(cycleId)`, `qk.payroll.cycle(cycleId)`                                                                                                                                                             |
| `POST /payroll/cycles/:id/lock-inputs`                                         | `qk.payroll.cycle(id)`                                                                             | `['payroll']`, `['attendance']`, `qk.bootstrap()` — this is what unblocks HR's Submit                                                                                                                                  |
| `POST /payroll/cycles/:id/validation-results/:rid/resolve`                     | that row in `qk.payroll.validation`                                                                | `qk.payroll.cycle(cycleId)`                                                                                                                                                                                            |
| `POST /accounts/reimbursement-batches` · `/add` · `/lock` · `/send-to-payroll` | —                                                                                                  | `['payroll','reimbursements']`, `['expenses']`, `qk.payroll.cycle(targetCycleId)`                                                                                                                                      |
| `POST /auth/…` (any auth route)                                                | —                                                                                                  | Not in this map. Auth mutations run through `authSession`, and a session change clears the whole cache (`hardLogout`) or reseeds it (`login`); a partial invalidation would leave the previous user's rows addressable |

**Optimism policy.** Optimistic updates are permitted for exactly two things: marking a
notification read, and marking an announcement read. Everything involving money, balances,
approvals, acknowledgements or workflow state waits for the server, because the server's number
is the only true one and a rolled-back optimistic balance is worse than a 400 ms wait.

**Invalidation is a declaration, not a call site.** `lib/invalidation.ts` exports
`INVALIDATION: Record<MutationId, (vars) => QueryKey[]>` and `useAppMutation()` reads it; a
mutation hook never calls `invalidateQueries` itself. `invalidation.test.ts` (§9) enumerates
`MutationId` and fails when a member has no row, so a new endpoint cannot ship without
declaring its blast radius. `MutationId` is in turn generated from the endpoint list in
`API.md` §13 by `scripts/extract-endpoints.mjs`, which is what makes "every mutation" a
checkable claim rather than an aspiration.

**Removal, not just staleness, for revoked data.** `payslip:revoked`, `SESSION_REVOKED`,
`404 NOT_FOUND` on a detail key, and `403 AUTHZ_DENIED` all call
`queryClient.removeQueries({queryKey})` for the affected key **in addition to** invalidating
its list. Invalidation alone leaves the old value renderable from cache while the refetch is in
flight — for a revoked payslip that is a number on screen the employee is no longer entitled to
see, which is precisely what Directive 2 forbids.

#### 1.4.5 Pagination

- **page/limit** endpoints (`directory`, `payslips`, `policies`, `form16`, `document-requests`,
  `dependents`, `approvals pending`, `attendance periods`, `payroll cycles`, `hr employees`,
  `policy compliance`) use `useQuery` + `placeholderData: keepPreviousData` and the `Pagination`
  primitive. `page` lives in the URL.
- **cursor** endpoints (`leave requests`, `expense claims`, `documents`, `announcements`,
  `tickets`, `notifications`, `approvals history`, `attendance records`, `validation results`,
  `payslip register`, `batch items`) use `useInfiniteQuery` with
  `getNextPageParam: (last) => last.page.nextCursor ?? undefined` and a "Load more" `Button`
  (`variant="secondary"`) — never an infinite scroll, which breaks the footer and screen readers.

### 1.5 Form handling

`react-hook-form` + `@hookform/resolvers/zod`. **Schemas are imported from
`@widedrop/shared`**, never redeclared: the same Zod object validates on the client for
immediacy and on the server for truth. Where a client-only refinement is needed (e.g. "end
date on or after start date" for early feedback) it is added with `.superRefine()` in
`features/*/schemas.ts` on top of the shared schema and is explicitly labelled advisory.

```ts
const form = useForm<z.infer<typeof leaveRequestCreate>>({
  resolver: zodResolver(leaveRequestCreate),
  mode: 'onSubmit',
  reValidateMode: 'onChange',
  defaultValues: {
    leaveTypeId: '',
    startDate: '',
    endDate: '',
    startPortion: 'FULL',
    endPortion: 'FULL',
    reason: '',
    submit: true,
  },
});
```

**The submit contract**, identical in every form:

1. `Button type="submit" loading={mutation.isPending} disabled={mutation.isPending}`.
2. `Idempotency-Key` from `useIdempotencyKey()` — a UUID whose lifetime is _one intended
   operation_, not one form instance. Precisely:

   | Event                                                 | Key                                                             |
   | ----------------------------------------------------- | --------------------------------------------------------------- |
   | First submit                                          | mint                                                            |
   | Network error / `5xx` / `409 IDEMPOTENCY_IN_PROGRESS` | **keep** — the user's retry must replay, not duplicate          |
   | `2xx`                                                 | regenerate (the next submit is a new operation)                 |
   | `4xx` that the user then _corrects_ (`422`, `400`)    | **regenerate on the first change to any form value afterwards** |
   | `403`/`409 GUARD_FAILED` with no body change          | keep                                                            |

   The fourth row is the one that is usually wrong. A server that has stored the key against
   the first body answers a corrected resubmission with `409 IDEMPOTENCY_KEY_REUSE`
   (`API.md` §9), which looks to the user like the portal refusing a fix they just made.
   `useIdempotencyKey()` therefore subscribes to the form's `isDirty` transition after a
   failed submit and mints a new key on it.

3. `If-Match` when the DTO carried a `version`, formatted as an **entity tag**:
   `` If-Match: `"${version}"` `` — a bare integer is not a valid `If-Match` value and is
   rejected by a conforming server. `apiClient` does the quoting from `version`, once, so no
   screen can get it wrong; `ETag` on the way in is unquoted by the same helper.
4. On `422`: `err.details.fieldErrors` → `setError(path, {type:'server', message})`; any
   field error without a matching form path, plus every `409`/`403`, goes to the `FormCard`
   `errorBanner`. This banner **is** the prototype's `lfErr` / `efErr` / `tfErr` slot, same
   position, same `--tone-red-fg` colour, now `role="alert"`. `422 FILE_NOT_CLEAN` is a banner
   error on every form that accepts an attachment (leave, expenses, tickets, profile change
   requests) and additionally clears the offending `FileField`, because the file is gone
   server-side and leaving its chip on screen invites a pointless retry.
5. On success: `form.reset()`, close the disclosure if the form was one (`efOpen`), and raise a
   toast built **only** from response fields —
   `` `${res.ticket.ticketNo} raised · first response within ${res.slaHours} hours` ``. A toast
   never contains a value the client invented.

**Server-authoritative fields are never inputs.** The leave form does not post `totalDays`
(the prototype computed it in the browser); the expense form does not post a total; the ticket
form does not post an id. Where the prototype showed a client-derived figure, §6 names the
response field that replaces it.

**Every form posts `submit: true` unless it has an explicit "Save draft" control.** Leave and
expense creation both take `submit z.boolean().default(true)` (`API.md` §13.4, §13.10); the
prototype has no draft affordance, so the SPA sends `true` and never exposes `DRAFT` as a state
the employee has to understand. The two-call path (`POST` then `POST …/:id/submit`) exists in
the API and is **not** used by these screens.

**Prototype field → request body, where the shapes differ.** The prototype's forms are flatter
than the API bodies. The mapping is fixed here so no implementer invents one:

| Form (prototype)       | Request field                                                                                                                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expenses · Description | **both** `title` (trimmed, first 200 chars) and `lines[0].description`. The API requires a header `title` (3–200) and a line `description` (3–500); the single-field prototype form supplies one value for both, and the field's own hint says so ("A short description — this is what your manager and Finance see") |
| Expenses · Amount (₹)  | `lines[0].amountMinor` = `Math.round(rupees * 100)`, computed by `toMinor()` in `@widedrop/shared`, which rejects more than two decimal places at the Zod layer rather than silently rounding                                                                                                                         |
| Expenses · Date        | **both** `spendDate` (header) and `lines[0].spendDate`                                                                                                                                                                                                                                                                |
| Expenses · Category    | **both** `expenseCategoryId` (header) and `lines[0].expenseCategoryId` (omitted, so it defaults to the header)                                                                                                                                                                                                        |
| Expenses · Attach bill | `attachmentFileIds[]`, max 5 (`API.md` §13.10)                                                                                                                                                                                                                                                                        |
| Help desk · Details    | `body`; attachments `attachmentFileIds[]`, max 3                                                                                                                                                                                                                                                                      |
| Leave · Reason         | `reason` (optional, ≤ 2000). Empty ⇒ **the field is omitted**, never sent as `''` and never back-filled with an invented note like the prototype's `'Awaiting Arjun Malhotra'`                                                                                                                                        |

A multi-line expense claim is out of scope for v1 — the API supports `lines[]` up to 50, the
prototype's form has one line, and the screen ships with one. The request is shaped as an array
from day one so adding a second line is additive, not a breaking change.

**Advisory previews are labelled.** The leave form may show "≈ 5 working days" from a local
weekday count, rendered in `--text-muted` with the caption "Weekends are not counted — the
final count is confirmed on submit". The persisted `totalDays` from the `201` response replaces
it immediately.

### 1.6 Error, loading and empty conventions

Every data surface (screen, card, table, list, tile) is in exactly one of four states. There is
no fifth state and no "render nothing".

| State       | Component                                 | Rule                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Loading** | `<Skeleton>` shaped like the real content | Skeletons mirror the final layout so nothing shifts. A card that will be 3 rows renders 3 skeleton rows. No spinners on first load; a spinner appears only inside a `Button` during a mutation. Minimum display 200 ms to avoid flicker; if the query resolves under 200 ms, the skeleton is skipped entirely (`isPending && !isFetchedAfterMount` guard). |
| **Error**   | `<ErrorState variant>`                    | `variant ∈ server \| forbidden \| notFound \| offline \| conflict`. Shows the server's safe `message`, a `Retry` button wired to `refetch()`, and the `requestId` in `--text-dim` as "Reference: 0f2c…". Scoped to the failing card, never the whole screen, when the screen has independent blocks (Home).                                                |
| **Empty**   | `<EmptyState>`                            | Copy comes from the response's `emptyState` (`title`, `message`) whenever present; §4 lists the local fallback for surfaces where the API sends none. Never a fabricated row, never `₹0`, never "3 items" when there are none.                                                                                                                             |
| **Data**    | The real component                        |                                                                                                                                                                                                                                                                                                                                                            |

A screen whose primary query errors renders `ErrorState` in the content area **with the shell
intact** — the sidebar, tabs and search keep working, so the user can navigate away.

**A fifth thing that is not a state: `partial`.** `GET /me/home` gives each block a 400 ms
budget; a block that exceeds it comes back `null` with its key appended to `partial[]`
(`API.md` §13.2). `partial` is **not** an empty state and must never render one — an empty
state asserts "there is nothing", and here we simply have not looked yet. The rule:

1. For each key in `partial[]`, the Home screen renders that card's **skeleton**, not its
   empty state, and immediately fires the block's dedicated query —
   `qk.payslips.list`, `qk.leave.balances`, `qk.approvals.pending`, `qk.announcements.list`,
   `qk.leave.holidays`, `qk.directory.reportingLine` — mapped by
   `HOME_BLOCK_QUERIES: Record<HomeBlockKey, () => UseQueryOptions>`.
2. That follow-up query's own result then drives the card through the normal four states,
   including its own `emptyState`.
3. `partial` is never used to hide an empty result; an empty block arrives as `[]`/`null`
   **with** its `emptyState`, and that is a genuine empty state.
4. A block still `partial` after its follow-up fails renders `ErrorState` scoped to the card.

This replaces the "Home is all-or-nothing" assumption that an earlier draft of §10 recorded as
an open risk; the API already solved it and the SPA must implement its half.

`<Suspense>` is not used for data; TanStack Query's `isPending` drives the skeletons. Suspense
wraps only `React.lazy` route chunks, with a full-content `Skeleton variant="screen"` fallback.

### 1.7 Bootstrap and shell render order

```
main.tsx → App → AppProviders → RouterProvider
  AuthProvider:      refresh → token → status
  ShellDataGate:     useMe() + useBootstrap()  (parallel)
     ├─ pending  → <AppShell.Skeleton/>         (sidebar rails + header bar + content skeleton)
     ├─ error    → <ErrorState variant="server" fullPage/>  with Retry and Sign out
     └─ success  → <AppShell …> <Outlet/> </AppShell>
```

`AppShell` receives `me` and `bootstrap` as props, not via a hook, so it is testable with
fixtures and has no hidden dependency on the network.

### 1.8 Screen ids, deep links and titles

`app/screenIds.ts` owns the only mapping between a server `deepLink.screen` value and a router
path. `NotificationDto.deepLink`, `SearchResultDto.deepLink` and
`HomeTodoDto.deepLink` all flow through `lib/deepLink.ts#toPath(deepLink)`.

**The parameter names are the server's, not ours.** `notification.deep_link_params` is a
persisted `jsonb` written by the API — `{"payslipId": "…"}`, `{"versionId": "…"}`,
`{"employeeId": "…"}` — and an earlier draft of this map read `params.id`, which would have
silently dropped every deep-linked payslip. Each entry below therefore declares the **server**
parameter name it accepts, and the SPA's own query-string spelling is a local concern:

```ts
type DeepLink = { screen: string; params?: Record<string, unknown> };

/** Per screen: the server params accepted (a closed allowlist) → the local path. */
export const SCREEN_PATHS = {
  home: (_p) => '/',
  payslips: (p) => q('/payslips', { id: str(p.payslipId) }),
  tax: (p) => q('/tax', { fy: str(p.fiscalYearId) }),
  profile: (p) => q('/profile', { tab: profileTab(p.tab) }),
  policies: (p) => q('/policies', { versionId: str(p.versionId) }),
  leave: (p) => q('/leave', { id: str(p.leaveRequestId) }),
  benefits: (_p) => '/benefits',
  expenses: (p) => q('/expenses', { id: str(p.expenseClaimId), new: flag(p.new) }),
  documents: (p) => q('/documents', { id: str(p.documentId) }),
  directory: (p) => q('/directory', { person: str(p.employeeId) }),
  announcements: (p) => q('/announcements', { id: str(p.announcementId) }),
  help: (p) => q('/help', { ticketId: str(p.ticketId) }),
  security: (_p) => '/security',
  approvals: (p) =>
    q('/approvals', { tab: apprTab(p.tab), kind: kind(p.kind), taskId: str(p.approvalTaskId) }),
  hrAttendance: (p) => (p.periodId ? `/hr/attendance/${enc(p.periodId)}` : '/hr/attendance'),
  hrEmployees: (p) => (p.employeeId ? `/hr/employees/${enc(p.employeeId)}` : '/hr/employees'),
  hrPolicies: (p) =>
    p.policyId && p.versionId
      ? `/hr/policies/${enc(p.policyId)}/versions/${enc(p.versionId)}`
      : '/hr/policies',
  hrAnnouncements: (_p) => '/hr/announcements',
  hrDocuments: (_p) => '/hr/documents',
  hrTickets: (p) => q('/hr/tickets', { id: str(p.ticketId) }),
  hrChangeRequests: (_p) => '/hr/profile-change-requests',
  payrollCycles: (p) => (p.cycleId ? `/accounts/payroll/${enc(p.cycleId)}` : '/accounts/payroll'),
  payrollInputs: (p) => `/accounts/payroll/${enc(req(p.cycleId))}/inputs`,
  payrollValidation: (p) => `/accounts/payroll/${enc(req(p.cycleId))}/validation`,
  payrollRegister: (p) => `/accounts/payroll/${enc(req(p.cycleId))}/register`,
  reimbursements: (_p) => '/accounts/reimbursements',
  audit: (p) => q('/audit', { eventId: str(p.auditEventId) }),
} as const satisfies Record<string, (p: Record<string, unknown>) => string>;
```

`str()` accepts a value only when it is a string matching `^[A-Za-z0-9_.:-]{1,64}$` (uuids and
slugs pass; anything else becomes `undefined`); `enc()` is `encodeURIComponent`; `q()` drops
`undefined` entries and builds the query string with `URLSearchParams`; `profileTab`,
`apprTab` and `kind` are enum guards; `req()` returns a sentinel that makes `toPath` bail to
`'/'` when a required path segment is missing.

`toPath` validates the incoming `screen` against this map and returns `'/'` for an unknown
value (forward compatibility: a newer API may emit a screen this build does not have, and the
DB column `deep_link_screen` is free `text`, so this is a live case, not a hypothetical). It
also returns `'/'` when `SCREEN_PATHS` resolves to a route the user cannot reach — `toPath`
takes `me.permissions` and re-checks §1.2's gate, so a notification written before a role was
removed lands on Home rather than on a forbidden screen. **A deep link never becomes an `href`
without passing through this function**, so a malicious or stale `deepLink` can produce neither
a `javascript:` URL nor an off-site absolute URL: every return value starts with a single `/`,
asserted by a unit test over a hostile-input corpus (`//evil.com`, `/\evil.com`,
`javascript:`, `\u0000`, an absolute `https://`, a path-traversal `../`).

`useDocumentTitle` sets `document.title = ${screenTitle} · ${organization.portalName}` where
`screenTitle` comes from the nav manifest (`bootstrap.nav`), which is also what the compact
`MobileHeader` renders — the prototype's `TITLES[screen]`, now server-supplied. Three screens
have no nav entry and take their title from a local `ui_copy`-free constant instead, because
they are structural rather than navigational: `NotFoundRoute` ("Page not found"),
`SecurityRoute` ("Security"), and the unauthenticated routes of §6.22 ("Sign in", "Verify your
identity", "Set a password", "Reset your password"). These strings are chrome, not data, and
are the only titles the SPA owns.

---

## 2. Design system implementation

### 2.1 The constraint, restated

`SECURITY.md` §6.3 ships `style-src 'self'; style-src-attr 'none'` with no nonce, because the
SPA is static on Netlify and a per-request nonce would need an edge function. Therefore the
prototype's 539 inline `style` attributes must become zero. The translation is mechanical:

| Prototype                                                                             | Production                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `style="background:#172236;border:1px solid #263247;border-radius:12px;padding:20px"` | `className={styles.card}` in `Card.module.css` reading `var(--surface-raised)`, `var(--border)`, `var(--radius-lg)`, `var(--space-10)`                                                                                                                                                                                                                                                                                                                                   |
| `style="background:{{ n.bg }};color:{{ n.color }}"` (nav item, 2 states)              | `<NavItem data-active={active}>` + `[data-active='true']` selector                                                                                                                                                                                                                                                                                                                                                                                                       |
| `style="background:{{ s.bg }};color:{{ s.fg }}"` (chip, 5 tones)                      | `<StatusChip data-tone="green">` + `[data-tone='green']` selector                                                                                                                                                                                                                                                                                                                                                                                                        |
| `style="background:{{ m.color }}"` (avatar, 6 departments + fallback)                 | `<Avatar data-dept="platform-engineering">` + `[data-dept]` selectors; unknown department omits the attribute and inherits `--dept-fallback`. **The slug is `department.slug`, a persisted column returned by the API** — never derived from `accentColourHex` (a colour is not an identifier) and never kebab-cased from `department.name` in the browser (two departments can share a display name across business units, and renaming one would silently recolour it) |
| `style="grid-template-columns:{{ splitCols }}"`                                       | `className={styles.splitGrid}` reading `var(--grid-split-current)`, flipped by `[data-stack='true']` on the shell                                                                                                                                                                                                                                                                                                                                                        |
| `style="width:{{ b.pct }}"` (progress bar, 0–100)                                     | `<ProgressBar>`'s **fill** element carries `data-pct={0..100}` (`.bar__fill[data-pct]`), matching the generated stylesheet of §2.3; the track carries no attribute                                                                                                                                                                                                                                                                                                       |
| `style="bottom:{{ toastBottom }}"`                                                    | `var(--toast-bottom)`, redefined under `[data-compact='true']`                                                                                                                                                                                                                                                                                                                                                                                                           |
| `style="transform:rotate({{ f.rot }})"` (accordion chevron)                           | `[aria-expanded='true'] .chevron { transform: rotate(180deg) }`                                                                                                                                                                                                                                                                                                                                                                                                          |
| `style="animation:fade .15s ease"`                                                    | `.popover { animation: fade var(--duration-fast) var(--ease) }` in the module                                                                                                                                                                                                                                                                                                                                                                                            |

CI enforcement: a Playwright assertion on the built app for every route —
`expect(await page.locator('[style]').count()).toBe(0)` — plus an ESLint rule banning the
`style` JSX prop outside an allowlist that is empty.

**SVG attributes are not inline styles.** `fill`, `stroke`, `stroke-width` on `<svg>`/`<path>`
are presentation attributes, unaffected by `style-src-attr`. `Icon` therefore sets
`stroke="currentColor"` and lets CSS colour it — which is also how a single icon serves active
and inactive nav states.

### 2.2 The `:root` token block

Shipped as `apps/web/src/styles/tokens.css`, imported first in `main.tsx`. Values are verbatim
from `design/DESIGN-SYSTEM.md`; the typed mirror is `@widedrop/shared` `design/tokens.ts`
(§2.5). **No component may introduce a literal colour, radius, or spacing value.**

```css
/*
 * Design tokens — the single source of truth for the portal's visual language.
 * Extracted from design/prototype/* and documented in design/DESIGN-SYSTEM.md.
 * The portal is dark by design; color-scheme: dark makes form controls, scrollbars
 * and the caret match without any further styling.
 */

:root {
  color-scheme: dark;

  /* ── Surfaces ───────────────────────────────────────────────────── */
  --surface-page: #070b12; /* outermost page background            */
  --surface-shell: #0f1622; /* app shell / content background       */
  --surface-panel: #121b2b; /* sidebar, top bar, popovers, inputs   */
  --surface-raised: #172236; /* cards, sheets, table wells           */
  --surface-hover: #1d2a42; /* row / list-item hover                */
  --surface-hover-nav: #1a2538; /* sidebar nav item hover               */
  --surface-selected: #1b365d; /* selected nav item, row, active pill  */
  --surface-on-accent: #0b1729; /* text on a --accent fill              */

  /* ── Borders ────────────────────────────────────────────────────── */
  --border: #263247;
  --border-subtle: #1f2a3d;
  --border-strong: #2f3d55;
  --border-frame: #2a3548;

  /* ── Text ───────────────────────────────────────────────────────── */
  --text: #f2f5fa;
  --text-invert: #ffffff;
  --text-bright: #d6deea;
  --text-secondary: #a9b4c7;
  --text-muted: #7c8aa3;
  --text-dim: #5f6d86;

  /* ── Accent ─────────────────────────────────────────────────────── */
  --accent: #6ea8ff;
  --accent-hover: #8dbbff;
  --accent-soft: #9cc2ff;
  --accent-pale: #cfe0ff;
  --accent-paler: #e6eeff;

  /* ── Status tones ───────────────────────────────────────────────── */
  --tone-green-bg: #14332a;
  --tone-green-fg: #5edba0;
  --tone-amber-bg: #3a2d12;
  --tone-amber-fg: #f5c46b;
  --tone-red-bg: #3b1e1e;
  --tone-red-fg: #f58c86;
  --tone-blue-bg: #1b365d;
  --tone-blue-fg: #9cc2ff;
  --tone-gray-bg: #222d40;
  --tone-gray-fg: #a9b4c7;

  /* ── Department accents (directory / team avatars) ──────────────── */
  --dept-platform-engineering: #1b365d;
  --dept-design: #3b2a5c;
  --dept-people-ops: #14332a;
  --dept-finance: #3a2d12;
  --dept-quality: #1f3a45;
  --dept-leadership: #3b1e1e;
  --dept-fallback: var(--surface-selected);

  /* ── Typography ─────────────────────────────────────────────────── */
  --font-sans: 'IBM Plex Sans', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

  --text-eyebrow: 11px;
  --text-caption: 11.5px;
  --text-meta: 12px;
  --text-body-sm: 13px;
  --text-body: 13.5px;
  --text-title: 15px;
  --text-heading: 17px;
  --text-heading-lg: 20px;
  --text-page-title: 24px;
  --text-page-title-lg: 26px;
  --text-metric: 24px;
  --text-metric-lg: 28px;
  --text-metric-xl: 32px;

  --weight-regular: 400;
  --weight-medium: 500;
  --weight-semibold: 600;

  --leading-tight: 1.25;
  --leading-normal: 1.5;
  --leading-relaxed: 1.65;
  --tracking-eyebrow: 0.08em;
  --tracking-title: -0.01em;
  --tracking-metric: -0.02em;

  /* ── Geometry ───────────────────────────────────────────────────── */
  --radius-sm: 8px; /* buttons, nav items          */
  --radius-md: 10px; /* icon buttons, inputs        */
  --radius-lg: 12px; /* cards, panels               */
  --radius-xl: 14px; /* popovers                    */
  --radius-sheet: 20px; /* mobile sheet top corners    */
  --radius-pill: 999px;
  --radius-circle: 50%;

  --space-1: 2px;
  --space-2: 4px;
  --space-3: 6px;
  --space-4: 8px;
  --space-5: 10px;
  --space-6: 12px;
  --space-7: 14px;
  --space-8: 16px;
  --space-9: 18px;
  --space-10: 20px;
  --space-12: 24px;
  --space-14: 28px;
  --space-16: 32px;
  --space-20: 40px;

  /* ── Layout ─────────────────────────────────────────────────────── */
  --sidebar-width: 248px;
  --sidebar-width-collapsed: 72px;
  --header-height: 66px;
  --header-height-compact: 64px;
  --tabbar-height: 62px;
  --content-padding: var(--space-14) var(--space-16) var(--space-20);
  --content-padding-compact: var(--space-10) var(--space-8) var(--space-16);
  --content-max-width: 1200px;

  /* Grid templates. The shell rewrites the -current variables at its own
     breakpoints, so a layout responds to the space it has, not the viewport. */
  --grid-split: 340px minmax(0, 1fr);
  --grid-form: 380px minmax(0, 1fr);
  --grid-calendar: minmax(0, 1fr) 340px;
  --grid-approvals: minmax(0, 1fr) 320px;
  --grid-stacked: 1fr;

  --grid-split-current: var(--grid-split);
  --grid-form-current: var(--grid-form);
  --grid-calendar-current: var(--grid-calendar);
  --grid-approvals-current: var(--grid-approvals);

  /* Auto-fit grids from the prototype, as named minimums */
  --autofit-metric: 170px; /* payslip YTD tiles           */
  --autofit-balance: 160px; /* leave balance tiles         */
  --autofit-stat: 200px; /* expense stat tiles          */
  --autofit-card: 250px; /* home top row                */
  --autofit-panel: 300px; /* home second row, tax row    */
  --autofit-benefit: 270px;
  --autofit-person: 230px; /* directory cards (auto-fill) */
  --autofit-field: 220px; /* profile field grid          */
  --autofit-meta: 150px; /* policy 4-up meta            */

  --toast-bottom: var(--space-14);

  /* ── Elevation ──────────────────────────────────────────────────── */
  --shadow-popover: 0 16px 40px rgba(0, 0, 0, 0.45);
  --shadow-notif: 0 20px 50px rgba(0, 0, 0, 0.5);
  --shadow-sheet: 0 -8px 32px rgba(0, 0, 0, 0.5);
  --shadow-toast: 0 10px 30px rgba(0, 0, 0, 0.45);
  --scrim: rgba(7, 11, 18, 0.72);

  /* ── Motion ─────────────────────────────────────────────────────── */
  --duration-fast: 150ms; /* fade   */
  --duration-base: 200ms; /* sheet  */
  --duration-slow: 250ms; /* rise   */
  --ease: cubic-bezier(0.22, 0.61, 0.36, 1);

  /* ── Focus ──────────────────────────────────────────────────────── */
  --focus-ring: 0 0 0 2px var(--surface-shell), 0 0 0 4px var(--accent);

  /* ── Stacking ───────────────────────────────────────────────────── */
  --z-sticky: 10;
  --z-tabbar: 40;
  --z-popover: 50;
  --z-sheet: 60;
  --z-modal: 70;
  --z-toast: 80;
}

/* Stacked layout: every split grid collapses together, in one place. */
[data-stack='true'] {
  --grid-split-current: var(--grid-stacked);
  --grid-form-current: var(--grid-stacked);
  --grid-calendar-current: var(--grid-stacked);
  --grid-approvals-current: var(--grid-stacked);
}

/* Compact shell: the bottom tab bar replaces the sidebar, so the toast clears it. */
[data-compact='true'] {
  --toast-bottom: 86px;
  --content-padding: var(--content-padding-compact);
  --header-height: var(--header-height-compact);
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-fast: 1ms;
    --duration-base: 1ms;
    --duration-slow: 1ms;
  }
}
```

`styles/global.css` additionally owns, and nothing else does: the `*{box-sizing}` reset, the
`body` background/`font-family`/`-webkit-font-smoothing`, the `scrollbar-color` pair, the
`a`/`a:hover` colours, `button,input,select,textarea{font-family:inherit}`, `:focus-visible`,
and the three prototype keyframes (`rise`, `fade`, `sheet`) reproduced verbatim.

### 2.3 Generated stylesheets

Two files are generated at build time by `scripts/generate-css.mjs` (run in `prebuild`), so no
continuous value ever needs an inline style:

1. `styles/generated/bar-widths.css` — `.bar__fill[data-pct='0'] … [data-pct='100'] { inline-size: N%; }`
   (101 rules, ≈ 1.4 KiB gzipped). `ProgressBar` rounds to an integer and clamps to 0–100, which
   is what the design system already specifies (`Math.round(left/total*100)`). A `null` percent
   omits the attribute entirely and the fill is not rendered at all.

   **Clamping is a drawing decision, never a reporting one.** A value above 100 (leave taken
   beyond entitlement, TDS ahead of projection) draws a full bar **and** sets
   `data-over="true"`, which renders the fill in `--tone-amber-fg` so a full bar and an
   overdrawn bar are visually distinct. The accessible name keeps the true figure:
   `aria-valuenow` is the unclamped integer, `aria-valuemax` is `100`, and `valueText` carries
   the server's exact words ("19.5 / 18 days"). Nothing the user reads is ever the clamped
   number. A negative percent is treated as `0` with the same rule inverted.

2. `styles/generated/dept-accents.css` — `[data-dept='platform-engineering'] { --avatar-bg: var(--dept-platform-engineering) }`
   … generated from `@widedrop/shared` `DEPARTMENT_ACCENTS`, so adding a department is a shared-package
   change, not a CSS edit. The key is the persisted `department.slug` the API returns; an
   unrecognised slug simply has no rule and inherits `--dept-fallback`. The six slugs in
   `DEPARTMENT_ACCENTS` are `platform-engineering`, `design`, `people-ops`, `finance`,
   `quality`, `leadership` (`DESIGN-SYSTEM.md` §1); a seventh department is a data change on
   the server and a one-line shared-package change here, in that order.

Both files are imported by `tokens.css` via `@import` at the top (Vite inlines them at build).

### 2.4 CSS Modules conventions

- One `.module.css` per component, colocated. No global class names except the three in
  `global.css`.
- Class naming: `.root`, `.header`, `.body`, `.footer`, plus semantic parts (`.metricValue`).
  Variants are attributes, not classes: `data-variant`, `data-tone`, `data-size`, `data-active`,
  `data-state`. This keeps the `className` prop a single value and makes the DOM readable in
  a bug report.
- Composition over prop explosion: `composes: card from '../Card/Card.module.css'` where a
  component genuinely is a card.
- No CSS-in-JS. No `styled-components`, no Emotion, no `@vanilla-extract/dynamic` — anything
  that injects a `<style>` element at runtime violates `style-src 'self'` without a nonce.
- Media queries are permitted only for genuinely viewport-level concerns (print, coarse
  pointer, `prefers-reduced-motion`). Layout breakpoints are container-driven (§3).

### 2.5 The typed token module

`packages/shared/src/design/tokens.ts` already exports `surface`, `border`, `text`, `accent`,
`tone`, plus the scale objects. The web app consumes it in exactly three ways and no others:

1. `generate-css.mjs` reads it to emit the generated stylesheets, so TS and CSS cannot drift.
2. `Icon` reads `ICON_PATHS` / `IconName` from `design/icons.ts` — the prototype's 24×24 path
   set, verbatim, plus the back-office additions (`payroll`, `upload`, `download`, `employees`,
   `audit`, `reimbursements`, `search`, `bell`, `close`, `chevronDown`, `chevronRight`, `check`,
   `alert`, `info`, `inbox`, `logout`, `settings`).
3. A Vitest contract test asserts every token in `tokens.ts` has a matching custom property in
   `tokens.css` and vice versa. A missing or extra token fails CI.

Components **never** read tokens from TS at render time. `var(--accent)` in CSS is the only way
a colour reaches the DOM.

### 2.6 Component API

Every primitive lives in `components/ui/<Name>/`. Props below are exhaustive: a prop not listed
does not exist. All components forward `ref`, accept `className` for layout-only composition
(margin/grid-area, never colour), and spread no unknown DOM props.

Shared types:

```ts
type Tone = 'GREEN' | 'AMBER' | 'RED' | 'BLUE' | 'GRAY'; // matches ChipDto.tone
type ChipDto = { value: string; label: string; tone: Tone };
type MoneyDto = { amountMinor: number; currency: 'INR' };
type MetricUnit = 'MONEY' | 'DAYS' | 'COUNT' | 'PERCENT';
type MetricDto = {
  key: string;
  label: string;
  unit: MetricUnit; // the API says how to read `value`; the caller never guesses
  value: MoneyDto | number | null;
  subLabel: string | null;
  isAvailable: boolean;
};
type EmptyStateDto = {
  code: string;
  title: string;
  message: string;
  params?: Record<string, unknown>;
};
type IconName = keyof typeof ICON_PATHS;
type ScreenId = keyof typeof SCREEN_PATHS;
```

#### Shell

```ts
interface AppShellProps {
  me: MeDto; // GET /me
  bootstrap: BootstrapDto; // GET /me/bootstrap
  children: ReactNode; // the routed screen
}
```

Owns the two `ResizeObserver` targets (§3), writes `data-compact` / `data-narrow` /
`data-stack` on its root, renders `Sidebar` **or** `MobileHeader` + `TabBar`, mounts
`GlobalSearch`, `NotificationPopover`, `MoreSheet`, `ToastProvider`'s viewport, and a single
`<main ref>` with `max-inline-size: var(--content-max-width)`. Exposes
`AppShell.Skeleton` as a static property for §1.7.

```ts
interface SidebarProps {
  org: { displayName: string; portalName: string; logoUrl: string | null };
  groups: NavGroupModel[]; // bootstrap.nav.groups, already permission-filtered server-side
  activeScreenId: ScreenId;
  user: {
    fullName: string;
    initials: string;
    employeeNumber: string;
    location: string;
    deptSlug: string | null;
  };
  collapsed: boolean; // labels hidden at 72px
  onNavigate(screenId: ScreenId): void;
  onOpenProfile(): void;
}
interface NavGroupModel {
  name: string;
  items: NavItemModel[];
}
interface NavItemModel {
  id: ScreenId;
  label: string;
  icon: IconName;
  badge: number | null;
}

interface NavGroupProps {
  name: string;
  showLabel: boolean;
  children: ReactNode;
}

interface NavItemProps {
  id: ScreenId;
  label: string;
  icon: IconName;
  active: boolean;
  showLabel: boolean;
  badge?: number | null; // null or 0 ⇒ no badge element rendered at all
  onSelect(id: ScreenId): void;
}
```

```ts
interface MobileHeaderProps {
  org: { portalName: string; logoUrl: string | null };
  title: string; // the active nav item's label
  unreadCount: number; // 0 ⇒ no dot
  user: { initials: string; fullName: string; deptSlug: string | null };
  onToggleNotifications(): void;
  onOpenProfile(): void;
}

interface TabBarProps {
  tabs: Array<{ id: ScreenId | 'more'; label: string; icon: IconName; active: boolean }>;
  onSelect(id: ScreenId | 'more'): void;
}

interface MoreSheetProps {
  open: boolean;
  items: NavItemModel[]; // the flat, permission-filtered manifest
  activeScreenId: ScreenId;
  onSelect(id: ScreenId): void;
  onClose(): void;
}
```

```ts
interface GlobalSearchProps {
  value: string;
  onChange(v: string): void;
  results: SearchResultDto[]; // GET /search
  status: 'idle' | 'loading' | 'error' | 'ready';
  onSelect(r: SearchResultDto): void; // → deepLink.toPath
  placeholder: string; // "Search payslips, policies, people…"
}
interface SearchResultDto {
  kind: 'MODULE' | 'PERSON' | 'POLICY' | 'PAYSLIP';
  label: string;
  sub: string;
  deepLink: { screen: ScreenId; params: Record<string, string> };
}

interface NotificationPopoverProps {
  open: boolean;
  items: NotificationDto[];
  isLoading: boolean;
  emptyState?: EmptyStateDto;
  onSelect(n: NotificationDto): void; // marks read + navigates
  onMarkAllRead(): void;
  onClose(): void;
}
```

```ts
interface ToastProviderProps {
  children: ReactNode;
}
type ToastTone = 'neutral' | 'success' | 'danger';
interface Toast {
  id: string;
  message: string;
  tone?: ToastTone;
  durationMs?: number;
} // default 2600
// useToast(): { show(message: string, opts?: {tone?: ToastTone; durationMs?: number}): void; dismiss(id: string): void }
```

One toast at a time, exactly as the prototype (`clearTimeout(this.tt)` replaces the previous).
The viewport is a single `aria-live="polite" aria-atomic="true"` region positioned at
`bottom: var(--toast-bottom)`. A toast is never the only channel for an error.

#### Surfaces and structure

```ts
interface CardProps {
  as?: 'div' | 'section' | 'article';
  padding?: 'none' | 'tight' | 'normal' | 'roomy'; // none | 6px 20px 8px | 16–18px | 20–22px
  tone?: 'default' | 'accent'; // accent = 1px solid var(--accent) (new-claim form, selected person)
  children: ReactNode;
  className?: string;
}

interface SectionHeaderProps {
  title: string;
  meta?: string; // right-aligned muted text, e.g. "FY 2026–27"
  action?: { label: string; onClick(): void } | { label: string; to: string }; // the accent text link
  as?: 'h2' | 'h3';
  id?: string; // for aria-labelledby on the owning region
}
```

`MetricTile` renders `metric.label` as the eyebrow, the formatted value (or `—` in
`--text-muted` with `aria-label="Not available"`) and `metric.subLabel` beneath. It never
receives a raw number: a caller with no `MetricDto` is a caller inventing data.

**`unit` is the formatter, `isAvailable` is the gate, and they are checked in that order.**
Three rules remove the ambiguity an earlier draft left between `value: null` and
`isAvailable: false`:

1. `isAvailable === false` ⇒ render `—` **whatever `value` holds**. The pair
   `{isAvailable: false, value: 0}` means "we cannot tell you this", not "zero"; rendering the
   `0` would be exactly the fabrication Directive 2 forbids.
2. `isAvailable === true && value === null` is a **contract violation**. `MetricTile` renders
   `—`, logs the `key` once per session through the error reporter, and the response schema in
   `features/*/schemas.ts` refines against it so it fails a test before it fails a user.
3. `isAvailable === true && value !== null` ⇒ format by `unit`: `MONEY` requires a `MoneyDto`
   and uses `formatInr`; `DAYS`, `COUNT` and `PERCENT` require a `number`. A `MoneyDto` under
   `COUNT`, or a bare number under `MONEY`, is a **type error at compile time** (the DTO is a
   discriminated union on `unit`) — which is the point: the earlier `format` prop let a caller
   render `12756000` paise as the count "12,756,000".

The `format` prop below is therefore **removed**; `MetricTile` takes the metric alone. `size`
survives because it is presentation.

```ts
interface MetricTileProps {
  metric: MetricDto;
  size?: 'md' | 'lg'; // 20px | 28px
}
```

```ts
interface StatusChipProps {
  chip: ChipDto; // label + tone come from the server
  size?: 'sm' | 'md'; // 11.5px | 12px
  minWidth?: boolean; // the expenses list aligns chips at 96px
}
```

Renders `<span data-tone={chip.tone.toLowerCase()}>` with the label as text. Because the label
is always present, the chip never relies on colour alone (§7.6). An unknown `tone` string falls
back to `gray` (rule 2 of the preamble says `GRAY`; the DTO value is uppercase, the
`data-tone` attribute is lowercase, and `StatusChip` is the single place the case changes).
An unknown `tone` is also reported once per session, because it means the SPA is older than
the API and someone should know.

```ts
interface DataTableColumn<T> {
  id: string;
  header: string;
  align?: 'start' | 'end';
  width?: 'auto' | 'content' | 'grow' | `${number}px`;
  numeric?: boolean; // applies font-variant-numeric: tabular-nums
  render(row: T): ReactNode;
  headerHidden?: boolean; // visually hidden but announced
}
interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowId(row: T): string;
  caption: string; // visually hidden <caption>, required
  state: 'loading' | 'error' | 'empty' | 'ready';
  skeletonRows?: number; // default 5
  empty?: EmptyStateProps;
  error?: ErrorStateProps;
  onRowActivate?(row: T): void; // makes rows keyboard-activatable
  selectedRowId?: string;
  stickyHeader?: boolean;
  footer?: ReactNode; // control totals row
}
```

Renders a real `<table>` with `<caption>`, `<th scope="col">` and `<tbody>`. Under
`[data-stack='true']` each row becomes a stacked definition block with the header text as a
`::before` label, preserving the prototype's mobile list feel without losing table semantics.

```ts
interface ListDetailSplitProps {
  grid: 'split' | 'form' | 'calendar' | 'approvals'; // → var(--grid-*-current)
  list: ReactNode;
  detail: ReactNode;
  align?: 'stretch' | 'start';
  listLabel: string; // aria-label for the list region
  detailLabel: string;
}

interface ProgressBarProps {
  percent: number | null; // null ⇒ track only, no fill, no aria value
  label: string; // accessible name, e.g. "Earned leave used"
  valueText?: string; // "14.5 / 18 days" for aria-valuetext
  size?: 'sm' | 'md'; // 4px | 6px
  tone?: 'accent'; // only accent exists; reserved for future
}
```

#### Forms

```ts
interface FormCardProps {
  title: string;
  description?: string;
  errorBanner?: string | null; // the lfErr / efErr / tfErr slot; role="alert"
  footerNote?: string; // "Weekends are not counted"
  submitLabel: string;
  submitting: boolean;
  disabled?: boolean;
  disabledReason?: string; // rendered as the note; never a silent dead button
  secondaryAction?: { label: string; onClick(): void };
  onSubmit(e: FormEvent): void;
  children: ReactNode;
  tone?: 'default' | 'accent';
}

interface FormFieldProps {
  id: string;
  label: string;
  optional?: boolean; // renders the muted "(optional)" the prototype shows
  hint?: string;
  error?: string; // wired to aria-describedby + aria-invalid
  children: ReactElement; // exactly one control
}

interface TextInputProps {
  id: string;
  value: string;
  onChange(v: string): void;
  type?: 'text' | 'email' | 'tel' | 'number';
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'email' | 'tel';
  invalid?: boolean;
  disabled?: boolean;
  autoComplete?: string;
  prefix?: string; /* "₹" */
}
interface SelectProps {
  id: string;
  value: string;
  onChange(v: string): void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
}
interface DateFieldProps {
  id: string;
  value: string /* YYYY-MM-DD */;
  onChange(v: string): void;
  min?: string;
  max?: string;
  invalid?: boolean;
  disabled?: boolean;
}
interface TextAreaProps {
  id: string;
  value: string;
  onChange(v: string): void;
  rows?: number;
  placeholder?: string;
  maxLength?: number;
  invalid?: boolean;
  disabled?: boolean;
  counter?: boolean;
}
interface FileFieldProps {
  id: string;
  accept: string[];
  maxBytes: number;
  onSelect(file: File): void;
  onRemove(): void;
  file?: { name: string; sizeBytes: number; scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' };
  disabled?: boolean;
  hint?: string;
}
```

`Select` is a native `<select>` styled with `appearance: none` plus a chevron background —
the prototype's `sc-raw-select`. Options always come from an API list **in the server's
`displayOrder`**; the SPA never sorts them, and a hardcoded `<option>` set is a §6 defect. The
placeholder option is `value=""`, `disabled`, and selected only while the field is untouched,
so a form can never submit a silently-defaulted first option the user did not choose — the
prototype's `lf.type: 'Earned leave'` default is deliberately **not** reproduced. `disabled`
options carry the persisted reason in their label (e.g. "Comp-off — no balance", where both
the type name and the reason come from `GET /leave/types`).

#### Actions

```ts
interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; // default 'secondary'
  size?: 'sm' | 'md'; // 8px 12px / 12.5px | 10px 16px / 13px
  type?: 'button' | 'submit';
  loading?: boolean; // shows an inline spinner, keeps the label, sets aria-busy
  disabled?: boolean;
  disabledReason?: string; // rendered as title + aria-describedby, never hidden
  iconStart?: IconName;
  iconEnd?: IconName;
  fullWidth?: boolean;
  onClick?(e: MouseEvent<HTMLButtonElement>): void;
  children: ReactNode;
}
interface LinkButtonProps extends Omit<ButtonProps, 'type' | 'onClick' | 'loading'> {
  to: string;
}

interface IconButtonProps {
  icon: IconName;
  label: string; // required — becomes aria-label
  variant?: 'outline' | 'ghost';
  size?: 'sm' | 'md'; // 34px | 38–40px
  badgeDot?: boolean; // the notification dot
  disabled?: boolean;
  onClick(): void;
}
```

`primary` = `--accent` fill with `--surface-on-accent` text. `secondary` = transparent with
`--border-strong`. `ghost` = the accent text links ("View all", "Apply", "Compare"). `danger`
is used only on destructive confirmations inside a `Modal`; the Approvals "Reject" button is
`secondary` with a red hover, exactly as the prototype.

```ts
interface AvatarProps {
  initials: string; // employee.initials — the API's generated column (§6.10)
  deptSlug?: string | null; // → data-dept
  size?: 24 | 30 | 32 | 34 | 36 | 40 | 44 | 56 | 60;
  label?: string; // accessible name when the avatar stands alone
  decorative?: boolean; // true ⇒ aria-hidden; the name is adjacent
}

interface IconProps {
  name: IconName;
  size?: 14 | 15 | 16 | 18 | 20 | 22;
  title?: string;
  className?: string;
}
```

`Icon` renders `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
stroke-linecap="round" stroke-linejoin="round"` and `aria-hidden` unless `title` is given.

**`initials`, precisely.** The API returns `employee.avatar_initials` (a generated column) on
every person-shaped DTO, and `Avatar` renders it verbatim. `@widedrop/shared` also exports an
`initials(fullName)` helper — the one the preamble's rule 1 lists as a permitted pure
formatter — and it exists for exactly one case: a `PersonRefDto` that legitimately carries no
`avatarInitials`, which today is none of them. It is **not** a fallback the SPA may reach for
when the field is missing; a missing `avatarInitials` renders the `Avatar` with no text and the
name beside it, and is reported as a contract violation. This resolves the apparent conflict
between rule 1 (initials is a formatter) and this section (initials comes from the server):
the server value always wins, the helper exists so the server and client can never disagree
about how one would be computed.

#### Disclosure and navigation within a screen

```ts
interface AccordionProps {
  items: Array<{ id: string; question: string; answer: ReactNode }>;
  openId: string | null; // single-open, like the prototype's faq index
  onToggle(id: string | null): void;
  headingLevel?: 3 | 4;
}

interface SegmentedTabsProps<T extends string> {
  variant: 'underline' | 'pill'; // profile tabs | approvals tabs
  tabs: Array<{ id: T; label: string; count?: number | null; disabled?: boolean }>;
  active: T;
  onChange(id: T): void;
  ariaLabel: string;
  activation?: 'manual' | 'automatic'; // default 'manual' — see §7.2
}
```

`count` renders the prototype's "Pending · 3" suffix. `count === null` renders no suffix;
`count === 0` renders "· 0" only when the count is a meaningful measured zero (the Approvals
tab), otherwise omit.

```ts
interface ModalProps {
  open: boolean;
  onClose(): void;
  title: string;
  description?: string;
  size?: 'sm' | 'md';
  initialFocusRef?: RefObject<HTMLElement>;
  footer: ReactNode; // buttons; the primary is last
  children: ReactNode;
  dismissible?: boolean; // false for step-up MFA
}
interface SheetProps extends Omit<ModalProps, 'size'> {
  side?: 'bottom';
}
```

`Modal` and `Sheet` share the focus-trap, scrim and escape handling; `Sheet` is the
bottom-anchored mobile presentation (the `MoreSheet` visual), `Modal` the centred one. Both
render into a portal at `#overlay-root`, set `aria-modal`, and restore focus on close.

```ts
interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  limit: number;
  onPageChange(page: number): void;
  itemNoun: { one: string; other: string }; // "person"/"people" — for the live summary
}
interface LoadMoreProps {
  hasMore: boolean;
  loading: boolean;
  onLoadMore(): void;
  loadedCount: number;
}
```

`Pagination` renders "Showing 1–25 of 214 people" in an `aria-live="polite"` region — the
prototype's "12 people shown", now sourced from `page.total`.

#### States

```ts
interface SkeletonProps {
  variant: 'text' | 'title' | 'metric' | 'chip' | 'avatar' | 'row' | 'card' | 'screen';
  lines?: number;
  width?: 'full' | 'half' | 'quarter';
}
interface EmptyStateProps {
  icon?: IconName; // outline glyph in --text-dim
  title: string; // 13.5px/500 --text-secondary
  message?: string; // 12px --text-muted
  action?: { label: string; onClick(): void } | { label: string; to: string };
  tone?: 'neutral' | 'positive'; // positive = the "All caught up" green check
  size?: 'inline' | 'block'; // inside a card row | 28–32px padded panel
}
interface ErrorStateProps {
  variant: 'server' | 'forbidden' | 'notFound' | 'offline' | 'conflict';
  title?: string;
  message?: string; // defaults per variant; server message wins when safe
  requestId?: string;
  onRetry?(): void;
  fullPage?: boolean;
}
```

`EmptyState` uses the design-system pattern: centred, `--surface-raised`,
`1px dashed var(--border)`, `--radius-lg`, 28–32px padding. It never renders a fake row and
never a zero. Copy is passed in — §4 is the register of what that copy is per surface.

### 2.7 Formatting and money — the shared contract

Every formatter the SPA may call is exported by `@widedrop/shared` and is **byte-for-byte the
function the API calls** (`API.md` §12.18). `lib/format.ts` re-exports them and defines
nothing. There are exactly seven, and no eighth may be added without adding it there first:

| Function                | Input                      | Notes                                                                                                                                        |
| ----------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `formatInr(money)`      | `MoneyDto`                 | `'₹' + Math.round(amountMinor / 100).toLocaleString('en-IN')` — whole rupees, Indian grouping (`DESIGN-SYSTEM.md` §10)                       |
| `formatInrExact(money)` | `MoneyDto`                 | Two decimal places. Used **only** where the API sets `precision: 'EXACT'` — today the payslip detail's line amounts and the payroll register |
| `fmt(date)`             | `YYYY-MM-DD` or an instant | `29 Sep 2026`                                                                                                                                |
| `fmtShort(instant)`     | instant                    | `31 Aug`                                                                                                                                     |
| `fmtLong(instant)`      | instant                    | `Tuesday, 29 September 2026`                                                                                                                 |
| `rel(instant, now)`     | instant + `serverTime`     | Bucketed, never continuous, so two renders a second apart agree                                                                              |
| `initials(fullName)`    | string                     | Parity helper only; the server's `avatarInitials` always wins (§2.6)                                                                         |

Four rules bind them, and each closes a way a wrong number could reach the screen:

1. **Locale and time zone are constants, not ambient.** Every call passes
   `organization.locale` and `organization.timezone` from `GET /me` (`en-IN`,
   `Asia/Kolkata`). A bare `toLocaleDateString()` with no `timeZone` renders in the _viewer's_
   zone, so a holiday stored as `2026-10-02` shows as **1 Oct** to anyone west of UTC+05:30.
   A `YYYY-MM-DD` value is a **calendar date with no instant**: it is split on `-` and
   formatted from its parts, never passed through `new Date()`, which would parse it as UTC
   midnight and reintroduce the same bug. An ESLint rule bans `toLocaleDateString`,
   `toLocaleString` and `Intl.DateTimeFormat` outside `@widedrop/shared`.
2. **Money crosses the wire only as `amountMinor`.** No float, no formatted string, no rupee
   value — including inside `emptyState.params`, search results and notification payloads
   (`API.md` §1.5). `toMinor(rupees)` exists for the one direction the SPA sends money (the
   expense amount field) and rejects more than two decimals rather than rounding them away.
3. **The SPA never sums, subtracts, or averages a displayed figure.** Gross, total deductions,
   net, YTD rollups, balances and control totals are all response fields. In particular, the
   payslip detail's earnings and deductions lines are rendered with `formatInrExact` **and the
   totals are the server's `grossEarnings` / `totalDeductions`** — the client must not add the
   lines up, both because rounding per line would not reconstruct the total and because the
   total is the audited figure. Where a rounded line list and a rounded total could visually
   disagree by a rupee, the exact formatter is used for both, so they do not.
4. **Percentages are the server's, with one exception.** `MetricDto`/`ProgressBar` percents
   are computed server-side (`round(available / nullif(entitlement,0) * 100)`), which is also
   why `entitlementDays = 0` arrives as `percent: null` rather than a division by zero. The
   single client-side percentage in the app is the Policy-compliance bar
   (`round(acknowledged / assigned * 100)`, §6.16), it is hidden when `assigned === 0`, and it
   is a bar width only — the four numbers beside it are all server fields.

---

## 3. Responsive behaviour

### 3.1 The contract, taken verbatim from the prototype

`prototype-logic.jsx#componentDidMount` observes **two** elements and derives three booleans:

| Observed element            | Threshold                 | Flag      | Effect                                                                                                                  |
| --------------------------- | ------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| the shell (`shellRef`)      | `contentRect.width < 880` | `compact` | Sidebar is replaced by `MobileHeader` + `TabBar`; content padding becomes `20px 16px 32px`; toast offset becomes `86px` |
| the main column (`mainRef`) | `contentRect.width < 820` | `narrow`  | Two-column split layouts collapse                                                                                       |
| —                           | `compact \|\| narrow`     | `stack`   | The four grid templates flip to `1fr`                                                                                   |

The four templates, unchanged:

| Name        | Wide                  | Stacked | Used by                           |
| ----------- | --------------------- | ------- | --------------------------------- |
| `splitCols` | `340px minmax(0,1fr)` | `1fr`   | Payslips, Policies, Announcements |
| `formCols`  | `380px minmax(0,1fr)` | `1fr`   | Leave, Documents, Help desk       |
| `calCols`   | `minmax(0,1fr) 340px` | `1fr`   | (reserved — leave calendar)       |
| `apprCols`  | `minmax(0,1fr) 320px` | `1fr`   | Approvals                         |

Two observers rather than one media query is a deliberate, preserved behaviour: the main column
is narrower than the shell by the sidebar's 248px, so a 1100px window has a wide shell and a
narrow main. A viewport media query cannot express that, and replacing it would change the
layout at real desktop widths.

### 3.2 Implementation — `hooks/useContainerBreakpoints.ts`

```ts
export interface ContainerBreakpoints {
  shellRef: RefObject<HTMLDivElement>;
  mainRef: RefObject<HTMLElement>;
  compact: boolean;
  narrow: boolean;
  stack: boolean; // compact || narrow
}
export function useContainerBreakpoints(opts?: {
  compactBelow?: number; // default 880
  narrowBelow?: number; // default 820
  forceCompact?: boolean; // the prototype's `viewport` prop, kept for Storybook/device preview only
}): ContainerBreakpoints;
```

Behaviour, matching the prototype exactly:

1. A single `ResizeObserver` observes both elements (one observer, two targets — the prototype's
   shape, and cheaper than two).
2. The callback computes both booleans and calls **one** state update containing only the flags
   that actually changed (`if (c !== compact) upd.compact = c`), so a resize that crosses neither
   threshold causes no render.
3. Updates are wrapped in a `requestAnimationFrame` coalescer to avoid the
   "ResizeObserver loop completed with undelivered notifications" warning when a flag flip
   changes layout and re-triggers the observer.
4. The observer is disconnected on unmount.

`AppShell` writes the result to the DOM as attributes, not styles:

```tsx
<div ref={shellRef} className={s.shell}
     data-compact={compact || undefined}
     data-narrow={narrow || undefined}
     data-stack={stack || undefined}>
```

`undefined` rather than `"false"` keeps the attribute absent when the flag is off, so
`[data-compact]` selectors are clean and the DOM reads as the prototype does.

Because `--grid-*-current`, `--toast-bottom` and `--content-padding` are redefined under
`[data-stack='true']` / `[data-compact='true']` (§2.2), **every** grid in the app responds from
those two attributes alone. A screen author writes `grid-template-columns: var(--grid-split-current)`
and gets the prototype's behaviour with no further code.

Context: `ShellBreakpointContext` publishes `{compact, narrow, stack}` so a deep child (the
toast viewport, the person card) can read them without prop drilling. The context value is
memoised on the three booleans so unrelated renders do not cascade.

### 3.3 Degradation without `ResizeObserver`

`ResizeObserver` is in every browser the app supports (`browserslist: >0.5%, last 2 versions,
not dead` — Safari 13.1+, Chrome 64+, Firefox 69+). Nonetheless the prototype guards with
`if (window.ResizeObserver)`, and production must too, because the observer is also absent in
jsdom (unit tests) and can be disabled in hardened environments.

The fallback chain:

1. **No `ResizeObserver`** → `useContainerBreakpoints` falls back to a `matchMedia` pair,
   `(max-width: 880px)` and `(max-width: 1068px)`. 1068 = 820 + 248, i.e. the viewport width at
   which the main column would be 820px with the sidebar expanded. This is an approximation and
   is documented as such in the hook; it is correct at the two widths that matter.
2. **No `matchMedia`** (very old jsdom) → the flags stay `false`, the desktop layout renders, and
   nothing breaks: every grid still has `minmax(0, 1fr)` on its flexible column, so content
   shrinks rather than overflowing.
3. **CSS-only safety net.** Independently of JS, `styles/global.css` carries
   `@media (max-width: 880px) { :root { --grid-split-current: var(--grid-stacked); … } }` for the
   four grid variables and the toast offset. If JS fails entirely after first paint, the layout
   is still usable on a phone. The JS attributes win when present because attribute selectors on
   the shell are more specific than `:root` under the same media query — the cascade is documented
   in a comment next to both blocks.
4. **Tests** stub `ResizeObserver` in `test/setup.ts` with a controllable fake, and
   `useContainerBreakpoints.test.ts` asserts each threshold, the "no redundant setState" rule, and
   the `matchMedia` fallback.

### 3.4 What compact changes, precisely

| Element              | Wide (`≥880px` shell)                                        | Compact (`<880px` shell)                                                                                                            |
| -------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Primary nav          | `Sidebar`, 248px (72px when collapsed), grouped, with badges | `MobileHeader` (logo · screen title · notifications · avatar) + `TabBar`                                                            |
| `TabBar` items       | —                                                            | Four slots + More, chosen by `tabPriority()` — the persona table in **§5.2** is the normative one, and this row does not restate it |
| Full nav             | Always visible                                               | `MoreSheet` — a bottom sheet, 3-column grid of every permitted nav item                                                             |
| Global search        | In the top bar                                               | Not in the header; reachable from the More sheet as a full-width search row                                                         |
| Content padding      | `28px 32px 40px`                                             | `20px 16px 32px`                                                                                                                    |
| Toast                | `bottom: 28px`                                               | `bottom: 86px` (clears the 62px tab bar plus its safe-area inset)                                                                   |
| Notification popover | Anchored under the bell, 360px                               | Full width minus 32px, same anchor                                                                                                  |
| Tables               | Real table rows                                              | Stacked definition rows (§2.6 `DataTable`)                                                                                          |

`TabBar` adds `padding-bottom: env(safe-area-inset-bottom)` and the toast offset adds it too, so
neither is obscured on an iPhone. The prototype's `framePad` / `shellMax` / `shellRadius` /
`shellBorder` device-frame props are a design-tool artefact and are **not** implemented: the
production shell is `100%` width and `100dvh` tall (`dvh`, not `vh`, so the mobile URL bar does
not clip the tab bar).

---

## 4. Empty states

Directive 9: every surface stays polished and truthful with zero data.

**Rules**

0. **An empty state is an assertion, and it must be true.** It is rendered only when the query
   has **resolved successfully** and the collection is genuinely empty. It is never rendered
   for a pending query (that is a `Skeleton`), never for a failed one (that is an
   `ErrorState`), and never for a `partial` block of `GET /me/home` (§1.6) — in that last case
   the answer is "not yet known", and asserting "there is nothing" would be a fabrication in
   the opposite direction. `useEmptyState(query, fallback)` encodes the check so no screen
   re-derives it.
1. When the response carries an `emptyState` object, its `title` and `message` are rendered
   verbatim. They are resolved server-side from `ui_copy` with persisted `params` interpolated —
   the SPA must not "improve" them. Interpolated `params` are rendered as **text nodes**, never
   as markup, so a `params.query` of `<img onerror=…>` is inert by construction (§8.4).
2. The **Local fallback** column below is used only when the endpoint sends no `emptyState`
   (`API.md` §1.6 rule 3: emptiness with no explanation beyond "there is nothing"). This copy is
   the one place the SPA owns words, and it contains no numbers, dates or names.
3. A metric tile with `value: null` renders `—` in `--text-muted` plus `subLabel`. If `subLabel`
   is also null, the fallback sub-label in the table is used.
4. A card whose entire content is unavailable still renders its `SectionHeader`, so the page
   composition is unchanged and the user can see the feature exists.
5. Where an action would help, the empty state offers exactly one `secondary` button, and only
   when the user holds the permission for it — `can(permission, scope)`, the same call as the
   control it shortcuts to. An empty state never offers an action the server would refuse.
6. **A local fallback contains no number, date, name or amount, ever.** The fallbacks in §4.1
   – §4.16 are a closed set of strings, and `emptyStateCopy.test.ts` asserts none of them
   matches `/\d/` — except the two interpolation slots `{query}` and `{passNo}`, which are
   substituted from the response and are declared in that test's allowlist. This is what stops
   the "helpful" empty state that says "0 payslips" from ever being written.
7. **A code the client does not recognise still renders.** `emptyState.code` is used only for
   telemetry and for the handful of screens in §6 that branch on it; the rendered words are
   always `title`/`message`. An unknown code is therefore harmless, which is what lets the API
   add one without a client release.

### 4.1 Shell

| Surface                | Server `emptyState.code` | Local fallback (title / message / action)                                                                           |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Notification popover   | `NOTIFICATIONS_NONE`     | "You're all caught up" / "New payslips, approvals and policy updates appear here." / —                              |
| Global search dropdown | — (`data: []`)           | "No matches for “{query}”" / "Try a name, a policy, a month, or a module." / — (single row, matching the prototype) |
| Nav badge              | —                        | `0` or `null` renders **no element** — never a "0" chip                                                             |
| Sidebar user card      | —                        | Always populated from `GET /me`; there is no empty case                                                             |

### 4.2 Home

| Surface                                  | Server code                                                                                             | Local fallback                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latest payslip card                      | `latestPayslipEmptyState` → `PAYSLIPS_CYCLE_IN_PROGRESS` / `PAYSLIPS_NO_CYCLE_YET` / `PAYSLIPS_REVOKED` | "No payslip yet" / "Your payslip appears here once payroll for the period is processed and published." / "View payslips"                                                                       |
| — its amount                             | —                                                                                                       | `—` with sub-label "Awaiting the first published payroll"                                                                                                                                      |
| Leave balance card                       | `LEAVE_NO_BALANCES`                                                                                     | "No leave balances yet" / "Balances appear once your leave scheme is set up for this leave year." / "Open Leave"                                                                               |
| A balance row with `entitlementDays = 0` | —                                                                                                       | Bar hidden; renders "0 / 0" is **forbidden** — render the count alone with the sub-label "No entitlement this year"                                                                            |
| Approvals card                           | `APPROVALS_ALL_CAUGHT_UP`                                                                               | "Nothing waiting on you" / "Leave, expense and attendance requests from your team appear here." / "Open approvals". Card is **omitted entirely** for a non-manager (the API omits `approvals`) |
| Announcements card                       | `ANNOUNCEMENTS_NONE`                                                                                    | "No announcements yet" / "Company updates from People Ops, Finance, IT and Leadership appear here." / —                                                                                        |
| Upcoming holidays                        | — (`data: []`)                                                                                          | "No upcoming holidays" / "Holidays for the rest of the year appear here once the calendar is published." / —                                                                                   |
| Team today                               | — (API omits `team` with no reports)                                                                    | Card omitted. When the array is present but empty: "No direct reports" / "People reporting to you appear here." / —                                                                            |
| Needs your attention                     | — (`todos: []`)                                                                                         | Block omitted entirely, exactly as the prototype's `hasTodos`                                                                                                                                  |

### 4.3 Payslips

| Surface                                                   | Server code                                                               | Local fallback                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4 YTD tiles                                               | metrics `value: null`                                                     | `—` plus, per tile: "No published payslip this financial year" (Gross earned), "0 payslips published" is **forbidden** — use "No payslips published yet" (Net credited), "No TDS recorded yet" (TDS deducted), "No PF recorded yet" (PF contributed) |
| Payslip list                                              | `PAYSLIPS_NO_CYCLE_YET`, `PAYSLIPS_CYCLE_IN_PROGRESS`, `PAYSLIPS_REVOKED` | "No payslips yet" / "Payslips appear here once payroll for the period is processed and published." / —                                                                                                                                               |
| Detail panel (nothing selected because the list is empty) | —                                                                         | Panel renders the same `EmptyState`, block size, so the split does not collapse asymmetrically                                                                                                                                                       |
| Bank line in the sub-header                               | `bankLine` omitted                                                        | The clause is dropped from the sub-header; no "••••" placeholder                                                                                                                                                                                     |
| Download button                                           | `409 PDF_NOT_READY`                                                       | Button disabled with `disabledReason` "The PDF is still being generated."                                                                                                                                                                            |

### 4.4 Tax slips

| Surface                     | Server code          | Local fallback                                                                                                                                                                                   |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TDS summary card            | `TAX_NO_PROJECTION`  | "No tax projection yet" / "Your projection appears after the first payroll of this financial year runs." / — . Every figure renders `—`; the progress bar renders as an empty track with no fill |
| PAN chip                    | `panMasked: null`    | Chip omitted; the sub-header drops the "· PAN …" clause                                                                                                                                          |
| Investment declaration card | `TAX_NO_DECLARATION` | "No declaration on file" / "Declare your investments when the window opens." / "Open declaration" (disabled with the persisted window dates when `isDeclarationOpen` is false)                   |
| Quarterly TDS rows          | — (always 4 rows)    | A quarter with `tdsDeducted: null` renders `—`, never `₹0`; its chip is the server's `UPCOMING` gray                                                                                             |
| Form 16 list                | `FORM16_NOT_ISSUED`  | "No Form 16 yet" / "Form 16 is issued after the financial year closes." / —                                                                                                                      |

### 4.5 My profile

| Surface                            | Server code         | Local fallback                                                                                                 |
| ---------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| A tab with no fields               | `PROFILE_TAB_EMPTY` | "Nothing recorded yet" / "These details appear here once People Ops adds them." / "Request a change"           |
| An individual field that is absent | —                   | The field is **omitted from the grid** (the API omits it); a present-but-unknown value is `null` → renders `—` |
| Emergency contacts tab             | — (`data: []`)      | "No emergency contacts" / "Add a contact so we know who to reach in an emergency." / "Add contact"             |
| Header chips                       | —                   | Only chips whose source field exists are rendered; there is no placeholder chip                                |

### 4.6 Policies

| Surface                            | Server code                      | Local fallback                                                                                        |
| ---------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Pending chip                       | `pendingCount: 0`                | Chip omitted                                                                                          |
| Policy list                        | `POLICIES_NONE_ASSIGNED`         | "No policies assigned" / "Policies that apply to you appear here when People Ops publishes them." / — |
| Detail panel with nothing selected | —                                | "Select a policy" / "Choose a policy from the list to read it and acknowledge." / —                   |
| "What this policy covers"          | `points: []`                     | Block omitted entirely                                                                                |
| Acknowledgement footer             | `requiresAcknowledgement: false` | Footer shows only the Download action; no acknowledge button, no "Due" text                           |
| Download PDF                       | `pdfAvailable: false`            | Button not rendered                                                                                   |

### 4.7 Leave

| Surface                      | Server code                     | Local fallback                                                                                                            |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Balance tiles                | `LEAVE_NO_BALANCES`             | "No balances for this leave year" / "Balances appear once your leave scheme is applied." / —                              |
| Apply form                   | `GET /leave/types` → `data: []` | Form disabled; `FormCard.disabledReason` = "No leave types are available to you yet. Raise a ticket if this looks wrong." |
| My requests                  | `LEAVE_NO_REQUESTS`             | "No leave requests" / "Requests you submit appear here with their status." / —                                            |
| Upcoming holidays            | — (`data: []`)                  | "No upcoming holidays" / "Holidays appear here once your location's calendar is published." / —                           |
| "N restricted holidays left" | RH balance absent               | Clause omitted from the header meta                                                                                       |

### 4.8 Benefits

| Surface                 | Server code                | Local fallback                                                                                                                                                                               |
| ----------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Benefit cards           | `BENEFITS_NONE_ACTIVE`     | "No active benefits" / "Your coverage appears here once enrolment is confirmed." / —                                                                                                         |
| A card's coverage value | `BENEFIT_AWAITING_PAYSLIP` | `—` with the server sub-label ("The employer contribution is confirmed on your first payslip")                                                                                               |
| A card's action         | `action.kind = 'NONE'`     | No button rendered. `isEnabled: false` renders a disabled button with the server's `disabledReason`                                                                                          |
| Dependents              | `DEPENDENTS_NONE`          | "No dependents added" / "Add the people covered by your benefits when the enrolment window is open." / "Add dependent" (disabled outside the window, with the persisted dates as the reason) |

### 4.9 Expenses

| Surface                   | Server code                             | Local fallback                                                                                                                                                                                                       |
| ------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3 stat tiles              | `EXPENSES_NONE_IN_FY`                   | `—` each, with sub-labels "Nothing awaiting approval", "Nothing approved and unpaid", "No reimbursements this financial year"                                                                                        |
| My claims                 | `EXPENSES_NONE_IN_FY`                   | "No claims yet" / "Submit a claim and it appears here with its approval status." / "New claim"                                                                                                                       |
| New claim form            | `GET /expenses/categories` → `data: []` | Form disabled; reason "No expense categories are configured yet."                                                                                                                                                    |
| "Goes to X, then Finance" | manager unresolved                      | The note reads "Goes to your manager, then Finance" only when `stats[0].subLabel` carries a name; otherwise the clause is dropped and the submit is blocked server-side with `MANAGER_NOT_RESOLVED`, surfaced inline |

### 4.10 Documents

| Surface              | Server code                                    | Local fallback                                                                             |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Letter request form  | `GET /documents/letter-templates` → `data: []` | Form disabled; reason "No letter types are available yet."                                 |
| SLA caption          | `slaWorkingDays` absent                        | Caption omitted rather than guessing a turnaround                                          |
| Letter requests list | — (`data: []`)                                 | "No letter requests" / "Letters you request appear here with their status." / —            |
| My documents         | `DOCUMENTS_NONE`                               | "No documents yet" / "Letters and certificates issued to you by Widedrop appear here." / — |

### 4.11 Directory

| Surface                               | Server code                                  | Local fallback                                                                                   |
| ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| People grid                           | `DIRECTORY_NO_MATCHES` (with `params.query`) | "No one matches “{query}”" / "Try a name, role or team." / "Clear search"                        |
| People grid with no query and no rows | —                                            | "The directory is empty" / "Colleagues appear here once People Ops publishes the directory." / — |
| Reporting line strip                  | both arrays empty                            | Strip omitted entirely                                                                           |
| "N people shown"                      | `page.total`                                 | Rendered only from `page.total`; with 0 the header meta is omitted                               |
| Selected person card                  | `404`                                        | `ErrorState variant="notFound"` inside the card slot, with "Close"                               |

### 4.12 Announcements

| Surface                      | Server code          | Local fallback                                                                              |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| List                         | `ANNOUNCEMENTS_NONE` | "No announcements" / "Updates from People Ops, Finance, IT and Leadership appear here." / — |
| Detail with nothing selected | —                    | "Select an announcement" / "Choose an update from the list to read it." / —                 |
| Attachment row               | `attachment: null`   | Row omitted                                                                                 |

### 4.13 Help desk

| Surface       | Server code                              | Local fallback                                                                     |
| ------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| Ticket form   | `GET /help-desk/categories` → `data: []` | Form disabled; reason "The help desk is not accepting tickets right now."          |
| SLA caption   | `firstResponseSlaLabel` absent           | Caption omitted                                                                    |
| My tickets    | `TICKETS_NONE`                           | "No tickets" / "Requests you raise appear here with their status and updates." / — |
| FAQ accordion | `data: []`                               | **Card not rendered at all** (`API.md` §13.14)                                     |

### 4.14 Approvals (Manager)

| Surface             | Server code               | Local fallback                                                                                                                                            |
| ------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending list        | `APPROVALS_ALL_CAUGHT_UP` | "All caught up" / "Nothing waiting on you. Decisions you made are under History." / — . `tone="positive"` renders the green check circle of the prototype |
| History list        | — (`data: []`)            | "No decisions yet" / "Requests you approve or reject appear here." / —                                                                                    |
| Tab label           | `page.total`              | "Pending · 0" is permitted here: it is a measured zero the manager needs to see                                                                           |
| "· N reports"       | `directReportCount: 0`    | Clause omitted                                                                                                                                            |
| Team today aside    | `team` omitted/empty      | Card omitted                                                                                                                                              |
| Aside upcoming note | team-calendar `data: []`  | Note omitted entirely — never "0 leaves upcoming"                                                                                                         |

### 4.15 HR screens

| Surface                      | Server code                                   | Local fallback                                                                                                                                                                                                                          |
| ---------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attendance periods           | `ATTENDANCE_NO_PERIODS`                       | "No attendance periods" / "A period appears here for each payroll cycle Accounts opens." / —                                                                                                                                            |
| Attendance records grid      | — (`data: []`)                                | "No records captured" / "Upload a file or add records to begin." / "Upload records"                                                                                                                                                     |
| Submit blocked               | `canSubmit: false`                            | The Submit button is disabled and the `submitBlockers[]` messages are rendered as a list above it, verbatim (e.g. "Accounts has not locked payroll inputs for August 2026 yet.")                                                        |
| Employees                    | — (`data: []`; `API.md` defines no code here) | "No employees match" / "Adjust the filters, or add an employee." / "Add employee" (shown only with `employee:create`)                                                                                                                   |
| Profile change-request queue | — (`data: []`)                                | "Nothing to review" / "Change requests raised by employees appear here." / —                                                                                                                                                            |
| Policies admin               | —                                             | "No policies yet" / "Create a policy and publish its first version." / "New policy"                                                                                                                                                     |
| Policy compliance            | `data: []`                                    | "No assignments" / "Assignments appear when this version is published." / —                                                                                                                                                             |
| Announcements admin          | —                                             | "No announcements" / "Draft an announcement and publish it to an audience." / "New announcement"                                                                                                                                        |
| Letter request queue         | —                                             | "Nothing in the queue" / "Letter requests from employees appear here." / —                                                                                                                                                              |
| Ticket queue                 | —                                             | "Queue is clear" / "New help-desk tickets appear here." / —                                                                                                                                                                             |
| Ticket email failure banner  | `notificationEmailStatus = 'FAILED'`          | Banner: "The email notification to {organization.helpdeskEmail} could not be delivered — this ticket is still open and assigned." with a Retry action for **`ticket:assign`** holders (`ticket:assign` is not a member of `Permission`) |

### 4.15b Manager · attendance slice (`/approvals/attendance/:approvalId`)

| Surface        | Server code        | Local fallback                                                                                               |
| -------------- | ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Records table  | — (`data: []`)     | "No records in your slice" / "People Ops has not captured attendance for your team for this period yet." / — |
| Decision panel | `decision` present | Panel shows the persisted decision and note; the Approve / Return buttons are not rendered                   |

### 4.15c Security (`/security`, §6.23)

| Surface         | Server code                      | Local fallback                                                                                                |
| --------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| MFA card        | `isEnrolled: false`              | "Two-step verification is off" / "Add an authenticator app to protect your pay and personal data." / "Set up" |
| Recovery codes  | `recoveryCodesRemaining: 0`      | "No recovery codes left" / "Generate a new set and store them somewhere safe." / "Generate codes"             |
| Active sessions | — (never empty: the current one) | No empty state exists; the current session is always a row                                                    |

### 4.16 Accounts screens

| Surface               | Server code                                        | Local fallback                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payroll cycles        | `PAYROLL_NO_CYCLES`                                | "No payroll cycles" / "Create a cycle for a pay period to begin." / "New cycle"                                                                                                                                       |
| Step tracker          | —                                                  | Always renders all seven steps; `PENDING` steps are `--text-dim`, `BLOCKED` steps show `blockedReason` inline. Never hidden                                                                                           |
| Control totals        | `controlTotals` members `null` before `CALCULATED` | `—` with the sub-label "Available after calculation"                                                                                                                                                                  |
| Input batches         | — (`data: []`)                                     | "No input batches" / "Upload a payroll input file to create the first batch." / "Upload file"                                                                                                                         |
| Batch rejections      | `rejections: []`                                   | "No rejected rows" / "Every row in this file parsed cleanly." / — (`tone="positive"`)                                                                                                                                 |
| Validation results    | `data: []` after a pass                            | "No issues found" / "Validation pass {passNo} raised nothing to resolve." / — (`tone="positive"`). Before any pass: "Not validated yet" / "Run validation once managers have approved attendance." / "Run validation" |
| Payslip register      | `data: []`                                         | "No payslips generated" / "The register fills after payroll is calculated." / —                                                                                                                                       |
| Reimbursement batches | `data: []`                                         | "No reimbursement batches" / "Create a batch to send approved claims to payroll." / "New batch"                                                                                                                       |
| Audit log             | `data: []`                                         | "No events match" / "Adjust the date range or filters." / "Clear filters"                                                                                                                                             |

---

## 5. Role-aware navigation

### 5.1 How the nav is built

The nav is **server-composed**: `GET /me/bootstrap` returns `nav.groups` already filtered by the
token's permissions, with group order and labels fixed by `DESIGN-SYSTEM.md` §6. The SPA renders
what it is given and does not own a nav array. Consequences that matter:

- A user without a permission never sees the item and never downloads its route chunk.
- A permission change takes effect on the next `bootstrap` fetch (≤ 5 min stale time, or
  immediately after any mutation that invalidates `qk.bootstrap()`), with no client release.
- `can()` is still used for **controls inside** a screen (buttons, columns), never for the nav.

`packages/shared` holds the manifest's _shape_ and the icon per screen id, so the server and
client agree on ids without the server shipping SVG paths:

```ts
export const NAV_MANIFEST = [
  { id: 'home', label: 'Home', group: 'Overview', icon: 'home', permission: 'profile:read:self' },
  {
    id: 'payslips',
    label: 'Payslips',
    group: 'Pay & tax',
    icon: 'payslips',
    permission: 'payslip:read:self',
  },
  {
    id: 'tax',
    label: 'Tax slips',
    group: 'Pay & tax',
    icon: 'tax',
    permission: 'tax:quarter:read:self',
  },
  {
    id: 'profile',
    label: 'My profile',
    group: 'My workplace',
    icon: 'profile',
    permission: 'profile:read:self',
  },
  {
    id: 'leave',
    label: 'Leave',
    group: 'My workplace',
    icon: 'leave',
    permission: 'leave:request:read:self',
  },
  {
    id: 'benefits',
    label: 'Benefits',
    group: 'My workplace',
    icon: 'benefits',
    permission: 'benefit:read:self',
  },
  {
    id: 'expenses',
    label: 'Expenses',
    group: 'My workplace',
    icon: 'expenses',
    permission: 'expense:claim:read:self',
  },
  {
    id: 'documents',
    label: 'Documents',
    group: 'My workplace',
    icon: 'documents',
    permission: 'document:read:self',
  },
  {
    id: 'policies',
    label: 'Policies',
    group: 'Company',
    icon: 'policies',
    permission: 'policy:read',
  },
  {
    id: 'directory',
    label: 'Directory',
    group: 'Company',
    icon: 'directory',
    permission: 'directory:read',
  },
  {
    id: 'announcements',
    label: 'Announcements',
    group: 'Company',
    icon: 'announcements',
    permission: 'announcement:read',
  },
  {
    id: 'help',
    label: 'Help desk',
    group: 'Support',
    icon: 'help',
    permission: 'ticket:read:self',
  },
  {
    id: 'approvals',
    label: 'Approvals',
    group: 'Manager',
    icon: 'approvals',
    permission: 'approval:task:read:team',
  },
  // ── appended after Manager, same visual treatment ──
  {
    id: 'hrAttendance',
    label: 'Attendance',
    group: 'People Ops',
    icon: 'attendance',
    permission: 'attendance:submit',
  },
  {
    id: 'hrEmployees',
    label: 'Employees',
    group: 'People Ops',
    icon: 'employees',
    permission: 'employee:read:any',
  },
  {
    id: 'hrPolicies',
    label: 'Policy admin',
    group: 'People Ops',
    icon: 'policies',
    permission: 'policy:author',
  },
  {
    id: 'hrAnnouncements',
    label: 'Announcement admin',
    group: 'People Ops',
    icon: 'announcements',
    permission: 'announcement:author',
  },
  {
    id: 'hrDocuments',
    label: 'Letters & records',
    group: 'People Ops',
    icon: 'documents',
    permission: 'document:request:read:any',
  },
  {
    id: 'hrTickets',
    label: 'Ticket queue',
    group: 'People Ops',
    icon: 'inbox',
    permission: 'ticket:read:any',
  },
  {
    id: 'hrChangeRequests',
    label: 'Change requests',
    group: 'People Ops',
    icon: 'profile',
    permission: 'profile:change_request:read:any',
  },
  {
    id: 'payrollCycles',
    label: 'Payroll cycles',
    group: 'Payroll',
    icon: 'payroll',
    permission: 'payroll:cycle:read',
  },
  {
    id: 'payrollInputs',
    label: 'Payroll inputs',
    group: 'Payroll',
    icon: 'upload',
    permission: 'payroll:input:read',
  },
  {
    id: 'payrollValidation',
    label: 'Validation',
    group: 'Payroll',
    icon: 'alert',
    permission: 'payroll:validation_issue:read',
  },
  {
    id: 'reimbursements',
    label: 'Reimbursements',
    group: 'Payroll',
    icon: 'reimbursements',
    permission: 'expense:reimburse',
  },
  { id: 'audit', label: 'Audit log', group: 'Compliance', icon: 'audit', permission: 'audit:read' },
] as const;
```

Group order is fixed and never sorted by the client:
`Overview → Pay & tax → My workplace → Company → Support → Manager → People Ops → Payroll → Compliance`.
A group with no permitted items is omitted along with its label, exactly as the prototype builds
`groups` from the items that survive filtering.

**`permission` here is `permission` + `scope`.** Each entry carries the scope its screen needs,
mirroring §1.2 — `hrEmployees` is `employee:read:any @ ORG`, `hrAttendance` is
`attendance:submit @ ORG`, `approvals` is `approval:task:read:team @ REPORTING_CHAIN`,
`payrollCycles` is `payroll:cycle:read @ ORG`. A pipe-separated string in an entry is an **OR
over permissions**, never over scopes. Written out, the shape is
`{ permission: Permission | Permission[]; scope: Scope }`; the single-string form above is
shorthand the manifest's loader expands.

**Why `approvals` is one code and not three.** An earlier draft gated it on
`leave:decide | expense:decide | attendance:approve`, none of which is a seeded code. The
Approvals screen reads the _unified_ `approval_task` queue (`DATA-MODEL.md` §19.1), so the
correct gate is the one code that reads that queue: `approval:task:read:team`. Acting on a task
still re-checks the underlying domain code (`leave:request:approve:team`,
`expense:claim:approve:team`, `attendance:approve:team`) server-side — `approval:task:act` is a
_router_, never a substitute for the domain permission (`SECURITY.md` §4.3.1).

**`security` has no manifest entry on purpose.** The Security screen (§6.23) is reached from
the user menu and from an `MFA_ENROL` / `MFA_RECOVERY_LOW` to-do deep link, not from the nav —
adding a tenth nav item to the prototype's sidebar for something visited twice a year would
change the navigation model the prototype defines. `SCREEN_PATHS.security` exists so the deep
link resolves; `bootstrap.nav` never contains it.

### 5.2 Final nav tree per persona

**Employee** (every user holds this)

```
Overview       Home
Pay & tax      Payslips · Tax slips
My workplace   My profile · Leave · Benefits · Expenses · Documents
Company        Policies · Directory · Announcements
Support        Help desk
```

**Manager** = Employee, plus:

```
Manager        Approvals  [badge: bootstrap.badges.approvals, omitted when 0]
```

**HR** = Employee, plus:

```
People Ops     Attendance · Employees · Policy admin · Announcement admin ·
               Letters & records · Ticket queue · Change requests
Payroll        Payroll cycles            (read-only: HR holds payroll:cycle:read so it can see
                                          when its attendance submission is due; every transition
                                          control is hidden and server-refused)
Compliance     Audit log
```

**Accounts** = Employee, plus:

```
Payroll        Payroll cycles · Payroll inputs · Validation · Reimbursements
Compliance     Audit log
```

**A user holding several roles** — the union of the groups above, in the fixed group order, with
each item appearing once. Two worked examples:

- _Manager + HR_ (an HRBP who also has reports): Overview, Pay & tax, My workplace, Company,
  Support, **Manager** (Approvals, badge), **People Ops** (six items), **Payroll** (Payroll
  cycles only, read-only), **Compliance**. The Approvals queue still shows only their own direct
  reports; being HR does not widen it (`SECURITY.md` §4.7).
- _HR + Accounts_ (small-company reality): every People Ops and Payroll item appears, but the
  maker-checker rules bite at action time — the same person cannot author and publish a policy,
  nor calculate and approve the same payroll run. The UI does not hide those buttons; it renders
  them and lets the server answer `409 SEGREGATION_REQUIRED`, whose message names the required
  second approver. Hiding would leave the user guessing; a refusal with a reason teaches the rule.

**Compact tab bar per persona** (5 slots, the prototype's rule generalised):

| Persona    | Slot 1 | 2        | 3                                                              | 4                                                | 5    |
| ---------- | ------ | -------- | -------------------------------------------------------------- | ------------------------------------------------ | ---- |
| Employee   | Home   | Payslips | Leave                                                          | My profile                                       | More |
| Manager    | Home   | Payslips | Leave                                                          | **Approvals**                                    | More |
| HR         | Home   | Payslips | **Attendance**                                                 | **Ticket queue**                                 | More |
| Accounts   | Home   | Payslips | **Payroll cycles**                                             | **Validation**                                   | More |
| Multi-role | Home   | Payslips | the first permitted of Approvals → Attendance → Payroll cycles | the next permitted of that list, else My profile | More |

`tabPriority(navItems)` is a pure function of the manifest and is the **single** definition of
those four slots; §3.4's table deliberately does not restate it. Written out:

```ts
// Slot 1 and 2 are fixed. Slots 3 and 4 are the first two survivors of this ordered list
// that the user actually holds, after removing anything already placed.
const TAB_PRIORITY: ScreenId[] = [
  'approvals', // a manager's queue is the thing they open the phone for
  'hrAttendance', // HR's deadline-bearing screen
  'payrollCycles', // Accounts' hub
  'hrTickets',
  'payrollValidation',
  'leave',
  'profile',
];
// tabs = ['home', 'payslips', ...take(2, TAB_PRIORITY ∩ permitted), 'more']
```

Worked against the personas this gives exactly the §5.2 table: Employee →
Home · Payslips · Leave · My profile · More; Manager → Home · Payslips · Approvals · Leave ·
More; HR → Home · Payslips · Attendance · Ticket queue · More; Accounts → Home · Payslips ·
Payroll cycles · Validation · More. `nav.persona.test.ts` asserts all five rows plus the
multi-role case, which is why the ordering lives in code and not in prose.

Everything not in the four slots is in the More sheet, which always lists the complete permitted
manifest grouped as in §5.2, plus a full-width search row and a link to **Security** (§6.23) —
the two things the compact header has no room for.

### 5.3 The new back-office screens, and which prototype pattern each reuses

| New screen                                              | Persona       | Prototype pattern reused                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Attendance periods** (`/hr/attendance`)               | HR            | Payslips list+detail `splitCols`: periods on the left with a status chip, the selected period's control totals, slice summary and Submit panel on the right. Submit blockers render in the Policies detail's bullet-list treatment                |
| **Attendance records** (`/hr/attendance/:periodId`)     | HR            | Expenses "My claims" table, upgraded to `DataTable` with a sticky header, inline editable day-count cells, and the control-total footer from the Payslips detail footer strip                                                                     |
| **Employees** (`/hr/employees`)                         | HR            | Directory card grid for the list, Directory person card for the selected employee, Profile tab strip for the detail's sections                                                                                                                    |
| **Employee detail** (`/hr/employees/:id`)               | HR            | My profile exactly: header block with chips, `SegmentedTabs variant="underline"`, field grid, tab note                                                                                                                                            |
| **Policy admin** (`/hr/policies`)                       | HR            | Policies `splitCols` with version rows in place of policy rows; the draft editor is the Leave "Apply for leave" `FormCard` widened to `formCols`                                                                                                  |
| **Policy compliance**                                   | HR            | Approvals history table plus the Payslips YTD tile row for `summary` (assigned / acknowledged / pending / overdue)                                                                                                                                |
| **Announcement admin** (`/hr/announcements`)            | HR            | Announcements `splitCols`; the composer replaces the reading pane, audience rules use the Policies 4-up meta grid                                                                                                                                 |
| **Letters & records** (`/hr/documents`)                 | HR            | Documents screen inverted: the queue table on the left (`formCols`), the issue form on the right                                                                                                                                                  |
| **Ticket queue** (`/hr/tickets`)                        | HR            | Help desk "My tickets" list as a `DataTable`, with the Approvals card layout for the selected ticket's thread                                                                                                                                     |
| **Payroll cycles** (`/accounts/payroll`)                | Accounts      | Payslips `splitCols`: cycles on the left; the detail pane is a new `StepTracker` composite (seven `DONE/CURRENT/BLOCKED/PENDING` rows styled like the Home "Needs your attention" rows) above the Payslips-detail footer strip for control totals |
| **Payroll inputs** (`/accounts/payroll/:id/inputs`)     | Accounts      | Expenses "New claim" `FormCard` for the upload, Expenses claims table for batches, and the rejection report as a red-toned `DataTable`                                                                                                            |
| **Validation** (`/accounts/payroll/:id/validation`)     | Accounts      | Policies detail's bullet list for a result's explanation; the results table is the Expenses table with a severity chip                                                                                                                            |
| **Payslip register** (`/accounts/payroll/:id/register`) | Accounts      | Payslips detail's earnings/deductions two-column grid, scaled to a `DataTable` with a control-total footer                                                                                                                                        |
| **Reimbursements** (`/accounts/reimbursements`)         | Accounts      | Expenses screen wholesale: three stat tiles, a batch table, and the claim picker as a checkbox `DataTable`                                                                                                                                        |
| **Audit log** (`/audit`)                                | HR + Accounts | Announcements `splitCols`: event rows on the left, the selected event's before/after in the Policies detail body treatment                                                                                                                        |

No new visual idiom is introduced anywhere. Every back-office screen is a recomposition of the
prototype's eight patterns: page header, metric tile row, list+detail split, form card, data
table, status chip, accordion, empty state.

### 5.4 Where `can()` gets its answer

`can()` cannot be cosmetic-but-correct without a source, and an earlier draft named none. The
source is **`GET /me` → `permissions`** (`API.md` §13.2), which returns the union of the
caller's permissions with the scope each is held at, computed server-side by
`effectivePermissions()` from `packages/shared/src/rbac/roles.ts`. The SPA:

- reads it from `useMe()`, never from a role list and never from the JWT;
- passes it to `can(permission, scope?)` and to `<RequirePermission>` through
  `PermissionContext`, memoised on the `me` object;
- treats an **absent** permission as denied, and an **unknown** permission string in the
  response as ignorable (forward compatibility);
- re-derives nothing on a role change: a grant or revocation lands on the next `GET /me`,
  which every mutation touching `role:assign` invalidates, and the server refuses in the
  meantime regardless.

**The three spellings problem, decided: there is now exactly one spelling.** Three were in
circulation — `packages/shared`'s `resource:action` (`policy:acknowledge`), `SECURITY.md` §4.4's
`verb:resource[:qualifier]` (`acknowledge:policy:self`), and `API.md` §13's
`resource[:subresource]:action[:scope]` (`policy:acknowledge:self`). **The seeded
`permission.code` of `DATA-MODEL.md` §3.1 wins**, which is the third form, because it is the
only one that is _persisted_: it is the string in `permission.code`, in
`state_transition.required_permission_code`, in `ess.scopes` (compared by
`has_scope()` as a whole array element), in `config.permission`, in
`audit_event.actor_permission_code` and in `GET /me`'s `permissions[]`. A grammar that only
exists in a document cannot be the arbiter of a grammar that exists in a database row.

Consequences, all of them binding:

- `packages/shared/src/rbac/roles.ts` is **regenerated** from `DATA-MODEL.md` §3.1 by
  `npm run gen:permissions`; its `PERMISSIONS` union is the seeded codes verbatim. CI fails if
  the committed file differs from the generated one.
- **`packages/shared/src/rbac/wire.ts`, `fromWire()` and `toWire()` are deleted.** A translation
  layer between two spellings of an authorization decision is exactly the place a privilege
  escalation hides: a `fromWire` that returns `null` for an unrecognised code silently degrades
  to "no permission" on a _deny_ path and to a swallowed grant on an _allow_ path, and neither
  failure is visible in a type. With one spelling there is nothing to translate.
- `apiClient` passes `me.permissions[]` through unchanged. `can(code, scope?)` and
  `<RequirePermission>` take a seeded code and the ABAC `Scope` of `SECURITY.md` §4.2
  (`SELF` | `DIRECT_REPORTS` | `REPORTING_CHAIN` | `DEPARTMENT` | `ORG`). The _permission
  string's_ scope segment (`self` | `team` | `skip_level` | `any` | `finance` | `global`) is part
  of the code; the _ABAC_ scope is the reach. They are related by the fixed mapping in
  `DATA-MODEL.md` §3.1 and are never conflated.
- `rbac.contract.test.ts` (§9) asserts that every code in `NAV_MANIFEST`, in the §1.2 route
  table and in every `can()` call site appears in the generated union, and `apiPaths.contract.test.ts`
  asserts the same for `API.md` §13's `config.permission` values. A permission cannot exist on
  one side of the wire and not the other.

---

## 6. Screen specs

Each subsection follows the same template:

- **Layout** — the skeleton copied from the prototype: which grid, which cards, in which order.
- **Fields** — every displayed value, its endpoint and response field.
- **Interactions** — controls and the mutations behind them.
- **Loading / Empty / Error** — the three non-data states.
- **Permission gate** — the route guard and the per-control `can()` checks.
- **Prototype hardcodes replaced** — every invented value in the prototype and its real source.

`§` markers: **[P]** = permission-gated control, **[S]** = step-up MFA may be required,
**[I]** = the mutation sends `Idempotency-Key`, **[V]** = the mutation sends `If-Match`.

### 6.0 Shell (every screen)

**Layout** (prototype lines 1–105). Flex row: `Sidebar` (248/72px, `--surface-panel`,
right border `--border-subtle`) then a column holding the header, the scrollable `<main>`
(`max-inline-size: var(--content-max-width)`, `margin-inline: auto`,
`padding: var(--content-padding)`), and — when compact — the `TabBar`.
Sidebar: logo + org block (18px 18px 14px, min-height 66px) → scrollable `<nav>` (gap 14px
between groups, 2px between items) → user card (14px, top border `--border-subtle`).
Desktop header: search (flex `1 1 320px`, max 440px) → date (margin-inline-start auto) →
notification `IconButton` → user button. Compact header: logo 26px → title → notification →
avatar button.

**Fields**

| Element                          | Source                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Logo                             | `GET /me` → `organization.logoUrl`, which is **same-origin or a `/api/v1/…` path** — `img-src 'self' blob:` (§8.3) blocks any external host, so an absolute off-origin URL is dropped and the bundled asset used instead, with the drop reported once. `null` ⇒ the bundled `/widedrop-logo.png`                         |
| "Widedrop" / "Employee portal"   | `organization.displayName` / `organization.portalName`                                                                                                                                                                                                                                                                   |
| Nav groups, labels, order, icons | `GET /me/bootstrap` → `nav.groups` (+ `NAV_MANIFEST` icon per id)                                                                                                                                                                                                                                                        |
| Approvals badge                  | `bootstrap.badges.approvals`; `0` ⇒ no element                                                                                                                                                                                                                                                                           |
| Notification dot                 | `GET /me/notifications/unread-count` → `unreadCount > 0`. This is the single source (§1.4.3); `bootstrap.badges.notificationsUnread` is the same query server-side and is not read here                                                                                                                                  |
| Sidebar user card                | `me.employee.initials`, `.fullName`, `` `${employeeNumber} · ${location}` ``                                                                                                                                                                                                                                             |
| Header user button               | `me.employee.fullName`, `.title`                                                                                                                                                                                                                                                                                         |
| Header date                      | `bootstrap.todayLabel` — a server string in `organization.timezone`, never `new Date()`                                                                                                                                                                                                                                  |
| Every relative label             | `rel(instant, me.serverTime)` (§2.7 rule 1); the SPA holds no local clock                                                                                                                                                                                                                                                |
| Search results                   | `GET /search?q=` → `data[]` (`kind`, `label`, `sub`, `deepLink`), **unpaged and capped at 8 server-side**; the SPA renders what it is given and neither truncates nor pads. The `PAYSLIP` kind is filtered by the same publication gate as `/me/payslips`, so search can never reveal that an unpublished payslip exists |
| Notification rows                | `GET /me/notifications` → `title`, `metaLabel`, `tone` (dot colour), `deepLink`                                                                                                                                                                                                                                          |

**Interactions**

- Nav item / tab / More-sheet item → `navigate(SCREEN_PATHS[id]())`, close overlays, scroll
  `<main>` to top on the next frame (the prototype's `requestAnimationFrame` reset).
- Search input → 250 ms debounce → `qk.search(q)`, `enabled: q.trim().length >= 2`; Enter
  activates the first result; Escape clears. Selecting a result → `toPath(deepLink)`. The
  query string is sent as typed and rendered back only inside `EmptyState.message` as a text
  node (§4 rule 1) — it never reaches an `href`, a `dangerouslySetInnerHTML`, or a log line.
- Notification row → `POST /me/notifications/read {ids:[id]}` then `toPath(deepLink)`.
- "Mark all read" → `POST /me/notifications/read {all:true}`; the badge is re-read from the
  response's `unreadCount`, not decremented locally.
- Avatar / user button → `/profile`.

**Loading** `AppShell.Skeleton`: sidebar rails with 6 shimmer rows, a header bar, and a
content-area `Skeleton variant="screen"`. **Error** `ErrorState variant="server" fullPage` with
Retry and Sign out. **Empty** — the shell has no empty state; a user with no permissions beyond
`profile:read:self` still gets Overview.

**Nav resilience.** `bootstrap.nav.groups` may name a `screenId` this build does not have (the
server was deployed first). Such an item is **dropped, silently, and reported once** — never
rendered as a dead button and never a crash. Symmetrically, a manifest entry the server did not
send is simply absent. `navManifest.contract.test.ts` in `packages/shared` asserts both sides
enumerate the same ids, so the drop path is a safety net rather than a routine occurrence.

**Permission gate** `<RequireAuth>` on the layout route. Nav filtering is server-side.

**Prototype hardcodes replaced** — `"Widedrop"`/`"Employee portal"` → `organization.*`;
`"PR"` → `employee.initials`; `"Priya Raghavan"` → `employee.fullName`;
`"WDT-01847 · Bengaluru"` → `employeeNumber` + `location`; `"Senior Software Engineer"` →
`employee.title`; `"Tue, 29 Sep 2026"` → `bootstrap.todayLabel`; the always-on notification dot
→ `GET /me/notifications/unread-count`; the hardcoded `notifs` array → `GET /me/notifications`; the client-side `results`
computed from `PEOPLE`/`POLICIES`/`PAYSLIPS` → `GET /search` (four scoped sub-queries, so search
can never surface a row the user cannot open).

### 6.1 Home (`isHome`, prototype line 106)

**Layout** Column, gap 22px:

1. Page header row: `h1` "{greeting}, {preferredName}" (26px/600) + sub-header; right-aligned
   `Button secondary` pair "Apply leave" / "Raise ticket".
2. `auto-fit minmax(var(--autofit-card),1fr)` grid, gap 16: **Latest payslip** card,
   **Leave balance** card, **Approvals** card _(managers only)_.
3. `auto-fit minmax(var(--autofit-panel),1fr)` grid, gap 16: **Announcements**, **Upcoming
   holidays**, **Team today** _(managers only)_.
4. **Needs your attention** card, rendered only when `todos.length > 0`.

All four blocks come from one call, `GET /me/home`, each block independently nullable, plus
the `partial[]` recovery path of §1.6. A key listed in `partial[]` renders that card's
**skeleton** and triggers its dedicated query; it never renders an empty state.

**Fields**

| Element                                      | Source                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Greeting                                     | `home.greetingKey` (`GOOD_MORNING`/`GOOD_AFTERNOON`/`GOOD_EVENING`, computed server-side against `organization.timezone`) resolved through the `ui_copy` labels the same response carries in `home.copy`; name = `me.employee.preferredName`. **The SPA does not read the browser's hour** — the prototype's `new Date().getHours()` is exactly the kind of client-derived value rule 6 forbids, and it is wrong for a traveller |
| Sub-header                                   | `home.subHeader` (composed server-side from date + location + site)                                                                                                                                                                                                                                                                                                                                                              |
| Latest payslip: month, amount, credited date | `latestPayslip.periodLabel`, `.netPay` (via `formatInr`), `.payDate`                                                                                                                                                                                                                                                                                                                                                             |
| Download PDF enabled                         | `latestPayslip.pdfAvailable`                                                                                                                                                                                                                                                                                                                                                                                                     |
| Leave balance rows                           | `leaveBalancesTop3[]`: `leaveTypeName`, `availableDays`, `entitlementDays`, `percent`                                                                                                                                                                                                                                                                                                                                            |
| Approvals count + label                      | `approvals.pendingCount`; the singular/plural label is the server's `ui_copy` pair selected by `Intl.PluralRules(locale).select(count)` — the SPA owns neither word                                                                                                                                                                                                                                                              |
| Approvals preview rows                       | `approvals.preview[]` → `subject.initials`, `subject.fullName`, `title`                                                                                                                                                                                                                                                                                                                                                          |
| Announcements rows                           | `announcements[]`: `title`, `categoryLabel`, `publishedAt`                                                                                                                                                                                                                                                                                                                                                                       |
| Holidays rows                                | `holidays[]`: `name`, and `date` (a `YYYY-MM-DD` **calendar date**) split into day / month / weekday by `fmtParts(date, organization.timezone)` from `@widedrop/shared` — parsed from its parts, never through `new Date()` (§2.7 rule 1)                                                                                                                                                                                        |
| Holiday card meta                            | `holidayCalendarName`                                                                                                                                                                                                                                                                                                                                                                                                            |
| Team rows                                    | `team[]`: `person.*`, `todayStatus` (`ChipDto`)                                                                                                                                                                                                                                                                                                                                                                                  |
| To-dos                                       | `todos[]`: `title`, `subtitle`, `actionLabel`, `tone` (dot), `deepLink`                                                                                                                                                                                                                                                                                                                                                          |
| "N open"                                     | `todos.length` — legitimate here because `todos` is **unpaged and complete** (`API.md` §13.2). The plural form comes from the `ui_copy` pair via `Intl.PluralRules`, not from `n > 1 ? 's' : ''`                                                                                                                                                                                                                                 |

**Interactions** "Apply leave" → `/leave`; "Raise ticket" → `/help`; "Download PDF" →
`download(GET /me/payslips/:id/download)`; "View details" → `/payslips?id=`; "Apply" →
`/leave`; "Review all" → `/approvals`; "View all" → `/announcements`; "Directory" →
`/directory`; an announcement row → `/announcements?id=`; a to-do row → `toPath(deepLink)`.
Home issues **no** mutations.

**The eight to-do kinds are handled, not assumed.** `todos[].kind` is a closed enum
(`API.md` §13.2): `POLICY_ACK`, `APPROVALS_PENDING`, `MFA_ENROL`, `MFA_RECOVERY_LOW`,
`TAX_DECLARATION_DUE`, `TAX_PROOF_DUE`, `TICKET_AWAITING_YOU`, `ATTENDANCE_APPROVAL_DUE`. The
SPA renders `title`, `subtitle`, `actionLabel` and `tone` verbatim for every one of them and
branches on `kind` for **nothing** — which is why the two MFA kinds work without a code change
here, provided `SCREEN_PATHS.security` exists (§1.8) and `/security` is routed (§1.2). A
`kind` this build does not know still renders, because nothing is keyed off it.

**Loading** Each card renders its own skeleton (metric shimmer, three bar rows, three list
rows) so the page composition is stable. **Empty** §4.2. **Error** Per-card `ErrorState` —
a failed `GET /me/home` renders one `ErrorState` in the content area, the shell intact.

**Permission gate** `profile:read:self` @ `SELF`. The Approvals and Team cards are absent from the
payload for non-managers; the SPA additionally guards with
`can('leave:request:approve:team','REPORTING_CHAIN') || can('expense:claim:approve:team','REPORTING_CHAIN') ||
can('attendance:approve','DIRECT_REPORTS')` so a stale payload cannot render a manager card.
The third disjunct matters: an HR-side manager may hold only `attendance:approve:team`.

**Prototype hardcodes replaced** — `"Good morning, Priya"` → `greetingKey` + `preferredName`;
`"Tuesday, 29 September 2026 · Bengaluru · Ecospace Tower A"` → `subHeader`; `PAYSLIPS[0]` net
and `"credited 31 Aug 2026"` → `latestPayslip`; `BAL.slice(0,3)` and the `pct` widths →
`leaveBalancesTop3[].percent`; `pendingCount` from a client array → `approvals.pendingCount`;
`ANN.slice(0,3)` → `announcements`; the `HOL` constant → `holidays` + `holidayCalendarName`;
`PEOPLE.filter(rel==='report')` and the `TEAM_TONE` map → `team[].todayStatus` (a `ChipDto`,
derived server-side from approved leave days and the holiday calendar); the `todos` built from
`POLICIES.filter(!ack)` → `todos[]`; `downloadLatest`'s invented filename toast → the
`filename` field of the `?mode=json` download response (§8.5), which is itself derived from
persisted columns; `new Date().getHours()` behind `greeting` → `home.greetingKey`;
`fmtD(new Date())` behind the sub-header → `home.subHeader`.

### 6.2 Payslips (`isPayslips`, line 202)

**Layout** Column, gap 22px:

1. Header row: `h1` "Payslips" + sub-header; right `StatusChip`-styled FY pill.
2. `auto-fit minmax(var(--autofit-metric),1fr)` metric row — four `MetricTile`s.
3. `ListDetailSplit grid="split"`: left a `Card padding="none"` of selectable payslip rows;
   right the detail `Card` — header strip (net pay, credited/mode/days, Download + Email
   buttons), a two-column `auto-fit minmax(250px,1fr)` grid of Earnings / Deductions with a
   bold total row each, then a footer strip (Employer PF · TDS this month · Reference in mono).

**Fields**

| Element                             | Source                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| FY pill                             | `GET /me/payslips` → `fiscalYear.label`                                                             |
| Sub-header bank clause              | `bankLine.bankName` + `bankLine.last4`; omitted when absent                                         |
| Sub-header pay-day clause           | `GET /me` → `organization` pay-day rule label                                                       |
| Four tiles                          | `ytd[]` (`GROSS_EARNED`, `NET_CREDITED`, `TDS_DEDUCTED`, `PF_CONTRIBUTED`) as `MetricDto`           |
| List rows                           | `data[]`: `periodLabel`, `payDate`, `netPay`                                                        |
| Detail net / credited / mode / days | `GET /me/payslips/:id` → `netPay`, `payDate`, `paymentMode`, `payableDays`/`totalDays`              |
| Earnings, Deductions                | `earnings[]`, `deductions[]` → `label`, `amount`; order is `display_order` — **the UI never sorts** |
| Gross / Total deductions            | `grossEarnings`, `totalDeductions`                                                                  |
| Employer PF / TDS / Reference       | `employerPf` (field omitted ⇒ clause omitted), `tds`, `reference`                                   |

**Interactions** Row click → `?id=`. The detail query is `enabled: !!id`; with no `id` **and a
non-empty list** the first row is selected in an effect with
`setSearchParams(…, {replace: true})` (§1.2). With an empty list nothing is selected and both
panes render the same `emptyState`. "Download PDF" **[P]** `payslip:read:self` @ `SELF` →
`GET /me/payslips/:id/download?mode=json` via `lib/download.ts` (§8.5); `409` with
`details.reason === 'PDF_NOT_READY'` disables the button with the server's message.
"Email me" **[I]** → `POST /me/payslips/:id/email` with an **empty body**; the toast reads
`` `Payslip sent to ${res.toAddressMasked}` `` from the response. There is no recipient input.

**Revocation is a removal, not a refresh.** A payslip can be revoked after the employee has
opened it (`PAYSLIPS_REVOKED`, `API.md` §13.7). Any `403`/`404` on `qk.payslips.detail(id)`
calls `queryClient.removeQueries` for that key **before** invalidating the list (§1.4.4), so
the previous amount cannot be repainted from cache while the refetch is in flight, and the
detail pane falls back to the list's `emptyState`. The same rule is why the payslips tier is
`staleTime: 30_000` with `refetchOnWindowFocus: 'always'` rather than something longer.

**Loading** Four tile skeletons + six list-row skeletons + a detail skeleton matching the
two-column grid. **Empty** §4.3 — and note the list and the detail render the _same_
`emptyState`, so the split does not look broken. **Error** `500 INTEGRITY_ASSERTION_FAILED`
renders `ErrorState variant="server"` with the message "This payslip could not be verified.
Payroll has been notified." and no numbers at all.

**Permission gate** route `payslip:read:self` @ `SELF`; download `payslip:read:self` @ `SELF`. The
Accounts register (§6.20) is a different screen behind `payslip:read:any` @ `ORG` — this
screen never widens.

**Directive 6, restated where it bites.** A payslip exists on this screen only after
_Accounts uploaded inputs → HR submitted attendance → every manager approved → validation
passed → generation ran → a second Accounts approver approved → the cycle published_. The SPA
enforces nothing of this and must not pretend to: it asks for published payslips, and the API
answers with rows or with an `emptyState` naming the honest reason
(`PAYSLIPS_NO_CYCLE_YET` / `PAYSLIPS_CYCLE_IN_PROGRESS` / `PAYSLIPS_REVOKED`). The screen
therefore has **no code path that could show a `GENERATED` payslip**, because it has no code
path that constructs a payslip at all. The raw `payroll_cycle.status` is deliberately not in
the employee payload, so "August payroll failed validation" can never leak through this UI.

**Prototype hardcodes replaced** — the entire `mkPay()` function (basic/HRA/special/LTA/
conveyance, `pf = basic*0.12`, PT ₹200, insurance ₹480) → `payslip_line` rows returned by the
API; `YTD` reduced over a client array → the `payslip_fy_rollup` metrics; `"FY 2026–27"` →
`fiscalYear.label`; `"HDFC Bank ••4412"` → `bankLine`; `"NEFT"` → `paymentMode`;
`"31 / 31"` → `payableDays`/`totalDays`; `"WDT-PS-2608-1847"` → `reference`; the six-element
`PAYSLIPS` array → the published-only query (a `GENERATED` payslip is a `404`, even for its
owner). The prototype's "Downloading Payslip_Aug-2026.pdf" toast is replaced by the browser's
own download; no toast claims a filename the server did not send.

### 6.3 Tax slips (`isTax`, line 253)

**Layout** Column, gap 22px:

1. Header row: `h1` + "Form 16, TDS and your declaration · PAN {masked}"; right regime pill.
2. `auto-fit minmax(var(--autofit-panel),1fr)`, align stretch: **TDS summary** card (eyebrow,
   big projected figure, a deducted/remaining `ProgressBar` with two captions, and a 3-up
   `auto-fit minmax(130px,1fr)` sub-figure grid above a top border) and a right column holding
   **Investment declaration** and **Quarterly TDS** cards.
3. **Form 16** card: rows of file icon + label + "Issued … · filename" + Download.

**Fields**

| Element                                               | Source (`GET /me/tax/summary` unless noted)                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| PAN chip                                              | `panMasked` (a `MaskedValueDto`-style string); `null` ⇒ clause omitted                       |
| Regime pill                                           | `regime.label`                                                                               |
| Projected annual tax                                  | `projection.projectedAnnualTax`                                                              |
| "Projected annual tax including N% cess"              | `regime.cessRatePercent`                                                                     |
| "Deducted {range}" + amount + percent                 | `projection.deductedRangeLabel`, `.tdsDeductedToDate`, `.deductedPercent`                    |
| Bar width                                             | `ProgressBar percent={projection.deductedPercent}`                                           |
| "{X} remaining · about {Y} per month over {N} months" | `.tdsRemaining`, `.nextMonthTdsEstimate`, `.remainingMonths`                                 |
| Projected gross / Standard deduction / Monthly TDS    | `.projectedGross`, `.standardDeduction`, `.monthlyTds`                                       |
| Declaration card status + body                        | `GET /me/tax/declaration` → `declaration.status` (ChipDto), `.submittedAt`, `window.*`       |
| Quarter rows                                          | `GET /me/tax/quarters` → `label`, `tdsDeducted` (null ⇒ `—`), `status`                       |
| Form 16 rows                                          | `GET /me/tax/form16` → `fiscalYearLabel`, `issuedAt`, `fileName`; card meta = `cardSubLabel` |

**Interactions** "Update declaration" **[P]** `tax:declaration:write:self` — enabled only when
`window.isDeclarationOpen`; disabled state shows the persisted `declarationOpensOn`/`ClosesOn`
as the reason. It navigates to the declaration editor (a `Modal` on this screen) whose save is
`PUT /me/tax/declaration` **[V]** followed by `POST /me/tax/declaration/submit` **[I][V]**.
Form 16 "Download" → `GET /me/tax/form16/:id/download`.
**"Compare regimes" is removed**: no endpoint produces a regime comparison, and the prototype's
"Old regime would cost ₹18,240 more this year" is an invented number. If the comparison is
wanted later it needs a persisted projection per regime and a new endpoint; until then the
control does not ship.

**Loading** Card-shaped skeletons; the summary card's figures are `Skeleton variant="metric"`.
**Empty** §4.4. **Error** Per-card.

**Permission gate** route `tax:quarter:read:self` @ `SELF`, with `alsoRequires: ['tax:declaration:read:self']` (`API.md` §5); declaration edits `tax:declaration:write:self` @ `SELF`.
`window.isDeclarationOpen` is a **server-computed boolean** (`API.md` §12.18) — the SPA never
compares today's date against the window, which would be both a client-clock read and a
duplicate of a rule that lives in `fiscal_year`.

**Prototype hardcodes replaced** — `₹2,74,320`, `₹1,16,230 · 42%`, `width:42%`, `₹1,58,090
remaining · about ₹22,584 per month over 7 months`, `₹22,04,820`, `₹75,000`, `₹22,860` → the
`employee_tax_projection` fields above; `"Submitted"` chip and `"Declared on 18 Apr 2026 …"` →
`declaration.status` + `.submittedAt` + `window.*`; the `TAXQ` array (including the two `—`
rows) → `GET /me/tax/quarters` (where `—` is now a persisted `null`, not a placeholder);
the `FORM16` array → `GET /me/tax/form16`; `"PAN AXYPR••••K"` → `panMasked`;
`"New regime · FY 2026–27"` → `regime.label`.

### 6.4 My profile (`isProfile`, line 305)

**Layout** Column, gap 22px:

1. **Header card** (`padding="roomy"`, flex wrap): 60px `Avatar`, name `h1` (22px), title line,
   a wrapped row of gray chips, and a right-aligned "Request a change" `Button secondary`.
2. `SegmentedTabs variant="underline"` on a `--border` bottom rule, horizontally scrollable.
3. **Fields card**: `auto-fit minmax(var(--autofit-field),1fr)` grid, gap 20/28, each cell an
   eyebrow label above a 14px value; a muted note paragraph under a top border.

**Fields** `GET /me/profile?tab=…` → `header.initials/fullName/titleLine/chips[]`,
`fields[]` (`label`, `value`, `isMasked`), `note`. The Emergency tab additionally reads
`GET /me/emergency-contacts`. A masked field renders its `masked` string plus, when
`canUnmask`, a small "Reveal" `Button variant="ghost" size="sm"` **[S]** that calls
`POST /me/profile/unmask {fieldKey}` and shows the value **for that field only**, reverting on
navigation. Tenure is a server-computed string; the client never subtracts dates.

**Interactions** Tab change → `?tab=`, a separate query per tab (cached independently). The
tab strip uses **manual activation** (§7.2): arrow keys move focus, `Enter`/`Space` activates.
Automatic activation would fire a network request for every tab the user arrows past.

"Request a change" **[I][S for bank/statutory]** → a `Modal` with `section`, `fieldKey`,
`requestedValue`, `reason` (min 10) and a proof `FileField` where required →
**`POST /me/profile-change-requests`** (the canonical path; `/me/profile/change-request` is
not routed — `API.md` §13.2).

**This does not raise a help-desk ticket.** The endpoint creates a `profile_change_request`
plus its `profile_change_request_field` rows, and no `helpdesk_ticket` exists to have a
number. The toast therefore reads the persisted `` `${res.requestNo} sent to People Ops` ``
and the screen invalidates `qk.profile.changeRequests`, **not** `qk.help.tickets`. The
prototype's `'HD-'+(4830+…)` toast is replaced by `requestNo`, and a "Pending changes" list
under the tab strip renders `GET /me/profile-change-requests`
(`emptyState.code = PROFILE_CHANGE_REQUESTS_NONE`, §4.5) so a submitted request is visible
rather than vanishing. Its rows show `status` (`ChipDto`), `requestedAt` and the HR `note` on
a rejection.

Emergency tab: add/edit/delete contacts **[V]**, gated on `emergency_contact:write:self` @ `SELF`.

**Loading** Header skeleton + 8 field-cell skeletons. **Empty** §4.5. **Error** Per-card.

**Permission gate** route `profile:read:self` @ `SELF`; change requests `profile:request-change`
@ `SELF`; emergency contacts `emergency_contact:write:self` @ `SELF`; unmask is server-gated and
always step-up + audited. A masked value is never sent back as an input (§8.6): the change
form's `requestedValue` is rejected client-side when it matches the field's `masked` string,
pre-empting the server's own refusal.

**Prototype hardcodes replaced** — the entire `PROFILE` object (personal, employment, bank,
emergency arrays) → `fields[]` per tab; `PNOTES` → `note`; `"4 years 2 months"` → the computed
`TENURE` field; `"Not applicable"` for ESI → the persisted `is_applicable=false` fact;
`"•••• •••• 4412"`, `"AXYPR••••K"` → server-side masks (`value_mask` columns, no decryption on
read); the four `PTABS` → the same four tab ids, now driven by the `tab` query param;
`requestChange`'s invented `HD-48xx` toast → the persisted `ticketNo`.

### 6.5 Policies (`isPolicies`, line 337)

**Layout** Column, gap 22px:

1. Header row: `h1` + "Company policies and your acknowledgements"; right an amber pill
   "{n} awaiting acknowledgement" when `pendingCount > 0`.
2. `ListDetailSplit grid="split"`: left a `Card padding="none"` of policy rows (name, "vX.Y ·
   Updated {label}", `StatusChip`); right the detail `Card padding="roomy"` — eyebrow
   ("{owner} · {version} · Updated {label}"), `h2` name, summary paragraph, a 4-up
   `auto-fit minmax(var(--autofit-meta),1fr)` meta grid between two rules (Applies to /
   Effective from / Next review / Questions), the "What this policy covers" bullet list, then a
   footer with the acknowledge control or the acknowledged confirmation, and Download PDF.

**Fields** `GET /me/policies` → `data[]` (`name`, `versionLabel`, `updatedLabel`, `status`,
`dueOn`, `acknowledgedAt`), `pendingCount`. `GET /me/policies/:versionId` → `owner`, `summary`,
`bodyMarkdown`, `bodySha256`, `appliesToLabel`, `effectiveFrom`, `nextReviewOn`, `contactEmail`,
`points[]`, `pdfAvailable`, `acknowledgementText`, `requiresAcknowledgement`.

The prototype showed a 3-bullet summary. Production renders `points[]` in that exact treatment
**and** the full `bodyMarkdown` beneath it, sanitised per §8.4 — an acknowledgement is only
meaningful if the whole policy was rendered.

**The read gate, and its three fallbacks.** The acknowledge button is disabled until the whole
body has been presented. "Presented" is decided in this order, and each step exists because the
one before it can be unavailable:

1. An `IntersectionObserver` on a sentinel element after the last rendered node. When the
   sentinel intersects the scroll container, the gate opens.
2. If the body fits without scrolling (`scrollHeight <= clientHeight` on the container,
   measured by the same `ResizeObserver` the shell already owns), the gate opens immediately —
   there is nothing to scroll to.
3. If neither observer is available (§3.3's hardened-environment case, jsdom), the gate opens
   after a `scroll` listener reports `scrollTop + clientHeight >= scrollHeight - 4`, and if
   there is no scroll container at all the gate opens. **The gate never becomes a permanent
   block**, because a control the user cannot satisfy is worse than no gate: the gate is a
   nudge, and the legal artefact is `acknowledged_body_sha256`, not the scroll event.

Keyboard users reach the sentinel by tabbing through the body's links or by pressing `End`
inside the focusable (`tabindex="0"`) scroll region, which carries an
`aria-label="Policy text"` and is announced as scrollable.

**The body is never truncated on this screen.** §8.4's 200 000-character cap is the server's
own limit on `bodyMarkdown` (`API.md` §13.13), so a compliant response always fits. If a body
ever does exceed the cap, the renderer **hides the acknowledge control entirely** and shows
"This policy is too long to display in full — download the PDF and acknowledge from there",
because acknowledging text the screen declined to render is exactly the defect the hash is
supposed to prevent. Truncate-and-still-acknowledge is forbidden.

**Interactions** Row click → `?versionId=`. **"I have read and acknowledge"** **[I]** →
**`POST /me/policy-versions/:versionId/acknowledge`** (canonical;
`/me/policies/:versionId/acknowledge` is **not routed** — `API.md` §13.13) with `bodySha256`
(echoed from the detail response) and `acknowledgementText` (echoed verbatim from
`acknowledgementText`, which the server compares against its own `ui_copy` value, so the SPA
must not trim, re-case or re-word it). On `201`/`200` the footer swaps to "Acknowledged on
{response.acknowledgedAt}" — **the persisted timestamp**, never `new Date()`.
On `422 BODY_HASH_MISMATCH` the screen refetches the detail and shows "This policy was updated
while you were reading it. Please read the new version.", using `details.currentVersionId` and
`details.currentBodySha256` from the error to navigate to and re-gate the new version — the
previous acknowledgement attempt is discarded, not retried. On `409 GUARD_FAILED`
(`policy.assignment_open`) it shows the server message and refetches the list.
Download **[P]** `policy:read` @ `SELF` → `GET /me/policies/:versionId/download?mode=json`;
the button is absent when `pdfAvailable` is false.

**What the echoed hash does and does not prove.** It proves the acknowledgement refers to the
**version the server served this client**, and it catches a republish mid-read. It does not by
itself prove the bytes reached a human's eyes — nothing client-side can. The honest claim,
which §8.4 now makes in these terms, is: the server persists
`acknowledged_body_sha256`, so which text was acknowledged is later provable from the audit
trail, and a changed policy invalidates a stale acknowledgement attempt rather than silently
accepting it.

**Loading** Eight list-row skeletons + a detail skeleton. **Empty** §4.6. **Error** Per-pane.

**Permission gate** route `policy:read` @ `SELF`; acknowledge `policy:acknowledge:self` @ `SELF`.
Directive 7 in full is satisfied by four persisted fields the screen renders and never
computes: the employee (implicit in `/me`), the **version** (`versionLabel` + `versionId`,
shown in the list row and the detail eyebrow), the **status** (`status` `ChipDto` —
`ACKNOWLEDGED` / `PENDING` / `OVERDUE`, derived server-side from `dueOn` against `serverTime`)
and the **timestamp** (`acknowledgedAt`). A superseded version shows its own historical
acknowledgement; acknowledging v3.1 never marks v4.2 acknowledged, which is why the list is
keyed by `versionId` and not by policy.

**Prototype hardcodes replaced** — the eight-element `POLICIES` array with its `ack` dates,
`due` dates, `points`, `summary`, `contact`, `applies`, `effective`, `review` → the two
endpoints above; the client-side `ack` state map and `polStatus()` → the server's derived
`status` `ChipDto` (`ACKNOWLEDGED`/`OVERDUE`/`PENDING`); `ackDate: polRaw.ack || '29 Sep 2026'`
— a fabricated fallback date — → the response's `acknowledgedAt`; `policyPendingCount` computed
client-side → `pendingCount`.

### 6.6 Leave (`isLeave`, line 385)

**Layout** Column, gap 22px:

1. Header: `h1` "Leave" + "Balances, requests and holidays · {leavePeriod.label}".
2. `auto-fit minmax(var(--autofit-balance),1fr)` tiles: per leave type — eyebrow name, "{avail}
   <small>/ {entitlement} days</small>", a 4px `ProgressBar`.
3. `ListDetailSplit grid="form"`: left the **Apply for leave** `FormCard`; right a column of
   **My requests** and **Upcoming holidays** cards.

**Fields** `GET /me/leave/balances` → `leavePeriod.label`, `data[]`
(`leaveTypeName`, `availableDays`, `entitlementDays`, `percent`). `GET /leave/types` → the
`Select` options **in `displayOrder`**. `GET /me/leave-requests` → rows
(`leaveType.name`, `rangeLabel`, `daysLabel`, `reason`, `status`, `canWithdraw`, `approver`).
`GET /leave/holidays` → `calendar.name` + `data[]`.

**Interactions** Submit **[I]** → `POST /me/leave-requests {leaveTypeId, startDate, endDate,
startPortion, endPortion, reason?, attachmentFileId?, submit: true}`. No `totalDays` and no
`employeeId` are sent — both are server-derived (`API.md` §13.4). `startPortion`/`endPortion`
are `FULL | FIRST_HALF | SECOND_HALF`; the prototype has no half-day control, so the form ships
a half-day `Select` on each date field defaulting to `FULL`, which is additive to the
prototype's layout (it sits in the date field's row) and is required for the API's own model to
be reachable at all. The success toast is
`` `Leave request sent to ${res.approver.fullName}` `` — from the response's resolved approver,
not a hardcoded manager name. Inline 422s: `NO_WORKING_DAYS_IN_RANGE`, `LEAVE_DATES_OVERLAP`,
`INSUFFICIENT_LEAVE_BALANCE` (shows `details` balance), `MIN_NOTICE_NOT_MET`,
`ATTACHMENT_REQUIRED`, `MANAGER_NOT_RESOLVED` — each rendered in the `FormCard` error banner
with the server message. "Withdraw" **[I][V]** → `POST /me/leave-requests/:id/withdraw`; the
control renders only when `canWithdraw` is true.

**Loading** Five tile skeletons, a form skeleton, four request-row skeletons.
**Empty** §4.7. **Error** Per-card; a failed `GET /leave/types` disables the form with a reason
rather than rendering an empty dropdown.

**Permission gate** route `leave:request:read:self` @ `SELF`; submit `leave:request:create:self` @ `SELF`; withdraw
`leave:request:withdraw:self` @ `SELF`, and only where the row's server-computed `canWithdraw` is true —
the SPA never infers withdrawability from `status`.

**Prototype hardcodes replaced** — the `BAL` array and its `pct` → `GET /me/leave/balances`;
the five hardcoded `<option>` values → `GET /leave/types`; the browser weekday loop in
`submitLeave` → the server's `working_days()` over the employee's week pattern and holiday
calendar (a local count may be shown as a labelled estimate, §1.5); `"Awaiting Arjun Malhotra"`
and the textarea placeholder `"Shared with Arjun Malhotra"` → `approver.fullName` from the
response / the resolved manager, and the placeholder becomes "Shared with your approving
manager"; `LEAVES0` → `GET /me/leave-requests`; `"Leave year Jan – Dec 2026"` →
`leavePeriod.label`; `"1 restricted holiday left"` → the restricted-holiday balance row;
`HOL` → `GET /leave/holidays` (one `date` per holiday, formatted client-side into day/month/
weekday rather than three stored strings).

### 6.7 Benefits (`isBenefits`, line 434)

**Layout** Column, gap 22px: header (`h1` + "Your coverage and allowances · {planYearLabel}");
`auto-fit minmax(var(--autofit-benefit),1fr)` cards (eyebrow category, name, big value, meta
paragraph, a bottom-aligned action `Button secondary`); then the **Dependents** card
(`SectionHeader` with an "Add dependent" ghost action, then rows of 32px `Avatar` + name +
"{relationship} · {age}" + cover label).

**Fields** `GET /me/benefits` → `planYearLabel`, `data[]` (`categoryLabel`, `name`,
`coverageValue` + `coverageDisplayHint`, `meta`, `status`, `action`, `enrolmentWindow`).
`GET /me/dependents` → `initials`, `fullName`, `relationshipLabel`, `ageYears`, `coverLabel`.

`coverageDisplayHint` decides the formatter: `AMOUNT` → `formatInr`, `MULTIPLE_OF_CTC` →
`` `${coverageMultiple}× annual CTC` ``, `MONTHLY_AMOUNT` → `` `${formatInr(v)} / mo` ``,
`PERCENT_OF_BASIC` → `` `${rate}% of basic` ``, `NONE` → the value element is omitted.

**Interactions** Card action is driven by `action.kind`: `DOWNLOAD_ECARD` →
`GET /me/benefits/enrolments/:id/ecard`; `VIEW_POLICY_DOCUMENT` → the plan document download;
`CHANGE_CONTRIBUTION` / `RAISE_TICKET` → opens the Help-desk ticket modal pre-filled with the
plan reference; `ADD_DEPENDENT` → the dependent modal; `NONE` → no button.
`isEnabled: false` renders the button disabled with the server's `disabledReason`.
"Add dependent" **[I]** → `POST /me/dependents`, window-guarded; outside the window the button
is disabled and its reason states the persisted `opensOn`/`closesOn`.

**Loading** Three card skeletons + two dependent rows. **Empty** §4.8. **Error** Per-card.

**Permission gate** route `benefit:read:self`; enrol/dependents `benefit:enrol:self`.

**Prototype hardcodes replaced** — the `BENEFITS` array (`₹5,00,000`, `3× annual CTC`,
`₹8,600 / mo`, the ICICI/HDFC/PRAN meta strings, the action labels and their toasts) →
`GET /me/benefits`; the NPS monthly figure specifically comes from the employer-contribution
component on the latest **published** payslip, and is `—` with an explanation when no payslip
exists yet; `DEPENDENTS` (names, ages, cover) → `GET /me/dependents` with server-computed
`ageYears`; `addDependent`'s toast "enrolment window · 1 – 15 Apr" → the persisted window dates.

### 6.8 Expenses (`isExpenses`, line 460)

**Layout** Column, gap 22px:

1. Header row: `h1` + "Claims approved by the {N}th are paid with that month's salary"; right a
   `Button primary` toggling the claim form ("New claim" / "Close").
2. `auto-fit minmax(var(--autofit-stat),1fr)` — three `MetricTile`s.
3. The **New claim** `FormCard tone="accent"` (rendered only while open, `animation: fade`):
   a `auto-fit minmax(180px,1fr)` row of Category / Amount (₹) / Date of spend, then a
   full-width Description, the error banner, and a footer of "Submit claim" + "Attach bill" +
   the routing note.
4. **My claims** card: rows of mono claim no. (76px) · title + "{category} · {date}{note}" ·
   amount · `StatusChip` (min-width 96px).

**Fields** `GET /me/expense-claims` → `stats[]` (three `MetricDto`), `data[]`
(`claimNo`, `title`, `category.name`, `spendDate`, `totalAmount`, `status`, `note`).
`GET /expenses/categories` → the `Select` options plus `requiresReceipt`,
`receiptRequiredAbove` and `limits[]` (used for an inline hint, e.g. "Cap ₹1,500 per month —
set by Travel & Expense Policy v3.0", with the cap and the policy label both from the API).

**Interactions** "Attach bill" → `FileField` → `POST /api/v1/files` with
`purpose=EXPENSE_BILL` (≤ 5 files, ≤ 10 MiB each, pdf/jpeg/png/heic — `API.md` §10.2); the returned `fileId` goes into `attachmentFileIds`. Upload shows the
scan status; a file that is not `CLEAN` blocks submit with the server's reason. Submit **[I]** →
`POST /me/expense-claims` with `lines[]` (the single-line form posts one line) and **no total**.
The toast reads `res.claimNo`. Inline 422s: `EXPENSE_LIMIT_EXCEEDED` (shows the cap and basis),
`ATTACHMENT_REQUIRED`, `CLAIM_WINDOW_CLOSED`, `MANAGER_NOT_RESOLVED`.
"Withdraw" appears on a row only when `canWithdraw` **[I][V]**.

**Loading** Three tile skeletons + six row skeletons. **Empty** §4.9. **Error** Per-card.

**Permission gate** route `expense:claim:read:self` @ `SELF`; create `expense:claim:create:self` @ `SELF`; withdraw
`expense:claim:withdraw:self` @ `SELF` and only where `canWithdraw` is true. The claim→body mapping is
fixed in §1.5; the amount is converted with `toMinor()` and never with `parseFloat * 100`.

**Prototype hardcodes replaced** — `EXP0` → `GET /me/expense-claims`; `expStats` summed in the
browser → the `expense_fy_rollup` metrics (including "4 claims since April", which is now
`reimbursed_count` + the fiscal year's start month); `"…with Arjun Malhotra"` →
`stats[0].subLabel`; `"Approved · paying 30 Sep"` / `"With September salary"` → the next
payroll cycle's label, or the honest fallback "Awaiting the next payroll cycle" when no cycle is
open; `'EXP-'+(2291+…)` → `claimNo` from `expense_claim_seq`; the six hardcoded category
options → `GET /expenses/categories`; `"Goes to Arjun Malhotra, then Finance"` → the manager
name from `stats[0].subLabel` plus the category's `requiresFinanceApproval`; "Claims approved by
the 25th" → `organization.expenseCutoffDayOfMonth`; `attachBill`'s "opens your files" toast →
a real upload.

### 6.9 Documents (`isDocuments`, line 503)

**Layout** Column, gap 22px: header; `ListDetailSplit grid="form"` with the **Request a letter**
`FormCard` on the left (Letter type `Select`, "Addressed to" optional `TextInput`, submit, and a
muted SLA paragraph) and the **Letter requests** card on the right (rows of type · "Requested
{date} · {purposeLabel}" · `StatusChip` · a download `IconButton` when downloadable); then the
**My documents** card (rows of a document glyph tile, name, "{category} · {date}", download
`IconButton`).

**Fields** `GET /documents/letter-templates` → options + `requiresAddressee` +
`slaWorkingDays` (the SLA paragraph is rebuilt from the **selected** template).
`GET /me/document-requests` → `templateName`, `requestedAt`, `purposeLabel`, `status`,
`isDownloadable`. `GET /me/documents` → `title`, `categoryLabel`, `documentDate`.

**Interactions** Submit **[I]** → `POST /me/document-requests`; "Addressed to" becomes required
(client + server) when the selected template's `requiresAddressee` is true. The toast reads
`res.requestNo` and the template's `slaWorkingDays`. Download → `GET /me/documents/:id/download`
or `GET /me/document-requests/:id/download`; the icon is rendered only when `isDownloadable`.

**Loading / Empty / Error** §1.6, §4.10.

**Permission gate** route `document:read:self` @ `SELF`; request `document:request:create:self` @ `SELF`.

**Prototype hardcodes replaced** — the five hardcoded letter `<option>`s →
`GET /documents/letter-templates`; `LET0` → `GET /me/document-requests`; `DOCS` →
`GET /me/documents`; `"Requested 29 Sep 2026"` hardcoded in `requestLetter()` → the persisted
`requestedAt`; `"General purpose"` / `"Addressed to X"` → the server's `purposeLabel`;
`"issued within 1 working day on company letterhead, digitally signed by People Ops"` → the
selected template's `slaWorkingDays` (the letterhead/signature clause stays as static product
copy because it describes the process, not a datum).

### 6.10 Directory (`isDirectory`, line 539)

**Layout** Column, gap 22px:

1. Header row: `h1` + "Find colleagues across Widedrop · {N} people shown"; right a 360px search
   `TextInput` with a leading search icon.
2. **Selected person** card (`tone="accent"`, `animation: fade`) when a person is selected:
   56px `Avatar`, name, "{title} · {dept} · {location}", a row of email / phone / "Reports to
   {name}", then "Copy email" and a close `IconButton`.
3. **Your reporting line** card, shown only when the search box is empty: a wrapped row of
   person buttons separated by chevrons.
4. `auto-fill minmax(var(--autofit-person),1fr)` grid of person cards (40px avatar, name, title,
   "{dept} · {location}").

**Fields** `GET /directory/people?q=&page=` → `data[]` (`fullName`, `avatarInitials`,
`department` → `{ id, name, slug }`, `designation`, `location`, `workEmail`, `workPhone?`)
and `page.total` (the header count). `GET /directory/people/:employeeId` adds `reportsTo`
(a `PersonRefDto`). The avatar's `data-dept` is `department.slug` — a persisted identifier —
**not** a hex colour mapped back to a name (§2.1).
`GET /me/reporting-line` → `ancestors[]`, `self`, `reports[]` with server-supplied
`relationLabel` strings.

**Interactions** Search → 250 ms debounce → `?q=` + `page=1`. Card click → `?person=`.
"Copy email" → `navigator.clipboard.writeText(person.workEmail)` inside try/catch; the toast is
`` `${workEmail} copied` `` and appears only on success (a clipboard failure shows the address
in a selectable inline field instead). `workPhone` is rendered only when the field is present —
it is omitted by the API unless the actor holds `directory:read_contact`.

**Loading** Twelve card skeletons. **Empty** §4.11. **Error** Per-region.

**Permission gate** route `directory:read` @ `ORG`. `workPhone` is a
**conditional field**: `API.md` §4.1 omits it unless the caller holds the API's
`directory:read_contact` grant, which has no `packages/shared` counterpart today. The SPA
therefore renders the phone row **iff the field is present in the response** and never calls
`can()` for it — a field-presence check is the correct client behaviour for a conditional
field, and inventing a `Permission` member the shared package does not export would not
compile. (Recorded in §10 as a vocabulary item to reconcile.)

**Prototype hardcodes replaced** — the twelve-person `PEOPLE` array, the derived `email`
(`name.toLowerCase().replace(' ','.')+'@widedrop.com'`) and `initials` → the API's
`workEmail` and `avatarInitials` (generated columns); `DEPT_COLOR` → the persisted
`department.slug` on `data-dept` (never a hex colour, §2.1); `"12 people shown"` → `page.total`; the reporting line assembled from
`PEOPLE[0]`, `PEOPLE[1]` and `rel==='report'` → `GET /me/reporting-line`; `person.phone`
(personal-looking mobile numbers) → `workPhone` only, permission-gated; the `mgr` string →
`reportsTo: PersonRefDto`.

### 6.11 Announcements (`isAnnouncements`, line 587)

**Layout** Column, gap 22px: header; `ListDetailSplit grid="split" align="start"` — left a
`Card padding="none"` of rows (a "Pinned" eyebrow when pinned, "{category} · {date}", title);
right the reading `Card padding="roomy"` — eyebrow, `h2`, body paragraphs (14px/1.65,
`--text-bright`), and a "Posted by {byline}" footer above a rule.

**Fields** `GET /me/announcements` → `title`, `categoryLabel`, `publishedAt`, `isPinned`,
`isRead`, `excerpt`. `GET /me/announcements/:id` adds `bodyMarkdown` and `attachment`.
Unread rows carry a small accent dot; read state comes from `isRead`, never from local storage.

**Interactions** Row click → `?id=`. Opening the detail fires
`POST /me/announcements/:id/read` (optimistic, rollback on error) — reading does **not**
implicitly mark read server-side, so the client must call it. Body markdown is rendered through
`lib/sanitize.ts` (§8.4). Attachment → signed-URL download.

**Loading** Six row skeletons + a detail skeleton of three paragraph blocks.
**Empty** §4.12. **Error** Per-pane.

**Permission gate** route `announcement:read` @ `SELF`. Audience filtering is a server-side
query predicate — a non-targeted announcement is not in the response at all, not merely hidden.

**Prototype hardcodes replaced** — the six-element `ANN` array with its `body` paragraph arrays
and `by` bylines → the two endpoints; `pinned: true` on the first item → `isPinned`;
the client's `ANN.slice(0,3)` for Home → `home.announcements`.

### 6.12 Help desk (`isHelp`, line 611)

**Layout** Column, gap 22px: header (`h1` + "Raise a request to People Ops, Payroll or IT ·
Typical first response {slaLabel}"); `ListDetailSplit grid="form" align="start"` — left the
**Raise a ticket** `FormCard` (Category `Select`, Subject, Details `TextArea`, error banner,
submit); right a column of **My tickets** and **Common questions**.

**Fields** `GET /help-desk/categories` → options + `firstResponseSlaLabel` (the header clause).
`GET /me/tickets` → `ticketNo`, `subject`, `category.name`, `metaLabel`, `status`.
`GET /help-desk/faq` → `question`, `answerMarkdown` (sanitised).

**Interactions** Submit **[I]** → `POST /me/tickets`. This is Directive 8's screen: the
transaction persists the ticket **and** enqueues the `email_outbox` row addressed to
`organization.helpdeskEmail` (`helpdesk@widedroptech.com`). The response carries
`notification.queuedTo`, and the toast reads:
`` `${res.ticket.ticketNo} raised · notified ${res.notification.queuedTo}` ``.
Email delivery is asynchronous and is **never** a precondition for the ticket — the employee-facing
screen therefore never shows a delivery status, and a later delivery failure is an HR/ops concern
(§4.15). Attachments via `POST /api/v1/files` (`purpose=TICKET_ATTACHMENT`, max 3).
FAQ rows use `Accordion` with single-open semantics.

**Where `helpdesk@widedroptech.com` comes from.** It is
`organization.helpdeskEmail`, a persisted column surfaced on `GET /me`, echoed back by the
create response as `notification.queuedTo`, and rendered from **that** field. The SPA does not
contain the address as a literal; `bundle.test.ts` (§9) greps `dist/` for
`widedroptech.com` and fails on a hit. This keeps Directive 8's address configurable and keeps
the toast honest: it names the address the server actually queued to, not the one the designer
typed.

**Loading** Form skeleton + three ticket rows + four FAQ rows. **Empty** §4.13 — note the FAQ
card is **not rendered at all** with zero rows. **Error** Per-card.

**Permission gate** route `ticket:read:self` @ `SELF`; create `ticket:create:self` @ `SELF`; comment
`ticket:comment:self` @ `SELF`.

**Prototype hardcodes replaced** — the seven hardcoded category `<option>`s →
`GET /help-desk/categories`; `'HD-'+(4830+len)` → `ticketNo` from `helpdesk_ticket_seq`;
`"Opened just now · unassigned"` → `metaLabel` (computed server-side from `assignee` and
`created_at`); `TK0` → `GET /me/tickets`; the four-item `FAQ` array → `GET /help-desk/faq`;
`"first response within 1 working day"` → `firstResponseSlaLabel`, derived from
`min(first_response_sla_hours)` against working hours.

### 6.13 Approvals (`isApprovals`, line 649, Manager)

**Layout** Column, gap 22px:

1. Header row: `h1` "Approvals" + "Leave and expense requests from your team · {N} reports";
   right `SegmentedTabs variant="pill"` — "Pending · {total}" / "History".
2. `ListDetailSplit grid="approvals" align="start"`: left the queue, right the **Team today**
   aside.
   - Pending: a column of `Card`s — 40px `Avatar`, a header line of name + kind `StatusChip`,
     the title line, a muted "{subtitle} · {requestedLabel}" line, and a right-aligned
     Reject / Approve pair.
   - History: one `Card padding="none"` with rows (32px avatar, "{name} · {title}",
     "{kind} · {decidedLabel}", outcome `StatusChip`).
   - Aside: Team today rows plus, beneath a rule, the upcoming-leave note.

**Fields** `GET /manager/approvals` → `data[]` (`ApprovalTaskDto`: `subject`, `kind`, `title`,
`subtitle`, `amount`, `requestedLabel`, `dueAt`, `isOverdue`, `entity`, `version`),
`page.total` (the tab count **and** the sidebar badge — one query), `directReportCount`.
`GET /manager/approvals/history` → the same DTO with `decision`.
Aside: `GET /me/home` → `team`; `GET /manager/leave/team-calendar` → the note (omitted when
the response has no rows).

**Interactions** `POST /manager/approvals/:id/decide` **[I][V]** with
`outcome ∈ {APPROVE, REJECT, REASSIGN}` (`API.md` §13.15) — three outcomes, not two:

| Outcome    | Control                                                                   | Body                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APPROVE`  | "Approve", `Button primary size="sm"`                                     | `{ outcome: 'APPROVE' }`, plus `approvedAmountMinor` for an `EXPENSE_CLAIM` partial approval                                                                                                                   |
| `REJECT`   | "Reject", `Button secondary` with a red hover (the prototype's treatment) | `{ outcome: 'REJECT', note }` — note **required**, ≥ 10 chars, collected in a `Modal`                                                                                                                          |
| `REASSIGN` | "Reassign", a `ghost` action in the card's overflow                       | `{ outcome: 'REASSIGN', note, reassignToEmployeeId }` — both required; the person picker is the Directory `Select` restricted to the actor's reporting chain, whose options come from `GET /me/reporting-line` |

A rejection without a reason is not actionable for the employee, and a reassignment without one
is not auditable; both are enforced by `approval.note_required` server-side and pre-checked by
the form. The row is removed on success and the badge is set from the response's `pendingCount`
— never decremented locally. `409 STATE_TRANSITION_NOT_ALLOWED` (someone else decided, or the
employee withdrew) shows "This request was already decided" and refetches.
`403 SELF_APPROVAL_FORBIDDEN` shows the server message and refetches.

**The partial-approval bound is the server's number.** `approvedAmountMinor` is validated
`>= 0` and `<= task.amount.amountMinor` from the task DTO, and the field is only shown for
`kind === 'EXPENSE_CLAIM'`. The SPA does not compute a remainder, a variance, or a "you saved
₹X" figure; the response's claim total after the decision is what the list re-reads.

**Four task kinds, not two.** `ApprovalTaskDto.kind` covers `LEAVE_REQUEST`, `EXPENSE_CLAIM`,
`ATTENDANCE_APPROVAL` and `DOCUMENT_REQUEST` (`API.md` §13.15 dispatches to all four). The card
renders `title`/`subtitle`/`amount` from the DTO for every kind — nothing is keyed off `kind`
except which per-kind permission the buttons check and where a "View detail" link points:

| `kind`                | Detail link                                                                                                                                                        | Button permission                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `LEAVE_REQUEST`       | none (the card carries the range, days and `balanceAfterDays`)                                                                                                     | `leave:request:approve:team` @ `REPORTING_CHAIN`                                 |
| `EXPENSE_CLAIM`       | `/expenses?id=` is **not** used — an employee route; the card shows the attachments via `GET /me/expense-claims/:id/attachments/:aid` equivalents under `/manager` | `expense:claim:approve:team` @ `REPORTING_CHAIN`                                 |
| `ATTENDANCE_APPROVAL` | **`/approvals/attendance/:approvalId`** (§6.15) — the manager's own read-only slice                                                                                | `attendance:approve:team` @ `REPORTING_CHAIN`                                    |
| `DOCUMENT_REQUEST`    | the card's own expandable detail                                                                                                                                   | `document:request:fulfil` (HR-held; a manager sees it read-only with the reason) |

**The attendance link was wrong and is corrected here.** An earlier draft pointed it at
`/hr/attendance/:periodId`, which is gated on `attendance:capture` @ `ORG` — a permission no
Manager holds. Following it would have produced `<ErrorState variant="forbidden">` on the one
screen the manager is being asked to act on. The manager's route is
`/approvals/attendance/:approvalId`, backed by `GET /manager/attendance/approvals/:id/records`.

**Loading** Four card skeletons + an aside skeleton. **Empty** §4.14 — the "All caught up"
block is `EmptyState tone="positive"`, matching the prototype's green check.
**Error** Per-pane.

**Permission gate** route `approval:task:read:team` @ `REPORTING_CHAIN` — one code, because the
queue is the single `approval_task` table; each card's buttons additionally check the
kind-specific permission from the
table above, so a manager who can approve leave but not expenses sees the expense card
read-only with the reason. Being HR does not widen this queue — `approval:task:read:any` is a
separate HR grant behind a separate screen, and `GET /manager/approvals` returns only tasks
assigned to the caller (`SECURITY.md` §4.7).

**Prototype hardcodes replaced** — `APR0` and `HIS0` → the two endpoints; `"· 3 reports"` →
`directReportCount`; `"Balance after: 9.5 days"` inside a hardcoded subtitle → the persisted
`leave_request.balance_after_days`, composed into `subtitle` server-side at task creation;
`"Requested 27 Sep"` → `requestedLabel`; the decision toast `"Approved · Neha Kulkarni has been
notified"` → the response plus the fact that a `notification` row was actually written
(the toast says "Approved · {subject.fullName} has been notified" only because the transaction
guarantees the notification); the aside note "Upcoming: Neha requested 5 – 9 Oct. Dussehra week
(20 Oct) has 1 approved leave." → `GET /manager/leave/team-calendar`, **omitted entirely** when
there are no rows.

### 6.14 HR · Attendance periods (`/hr/attendance`)

**Layout** `ListDetailSplit grid="split"`. Left: period rows (label, "{startDate} – {endDate}",
`StatusChip`). Right: a `Card` with a 3-up `MetricTile` row (Records captured / Expected
employees / Total payable days), a **Slices** `DataTable` (manager · record count · status ·
decided), then a **Submit** panel: the control-total inputs (`declaredRecordCount`,
`declaredTotalPayableDays`), the blocker list, and the Submit button.

**Fields** `GET /hr/attendance/periods` → `AttendancePeriodDto` (`label`, `status`,
`recordCount`, `expectedEmployeeCount`, `sliceSummary[]`, `payrollCycle`, `canSubmit`,
`submitBlockers[]`, `hrSubmittedAt`, `version`).

**Interactions** "Capture records" → `/hr/attendance/:periodId`. **Submit** **[I][V]** →
`POST /hr/attendance/periods/:id/submit`. The button is enabled only when `canSubmit`; when it
is false the `submitBlockers[]` messages render verbatim above it — most importantly
_"Accounts has not locked payroll inputs for {period} yet."_ This is the UI face of workflow
step 2 waiting on step 1. `422 CONTROL_TOTAL_MISMATCH` renders inline with the server's actual
figures. "Reopen" **[I][V]** (`attendance:submit` + the guard) requires a reason ≥ 10 chars.

**Empty / Error** §4.15. **Permission gate** route `attendance:submit` @ `ORG`; the capture
link needs `attendance:capture` @ `ORG`. HR only — a manager never reaches this screen (§6.13).

### 6.15 HR · Attendance records (`/hr/attendance/:periodId`)

**Layout** Header with the period label and `StatusChip`; a filter row (search by name/number,
manager, department, status); a sticky-header `DataTable` of `AttendanceRecordDto` columns —
Employee (avatar + name + number) · Eligible · Present · Paid leave · Holiday · Week off ·
Absent · LOP · **Payable** (read-only, generated) · Status · Source; a footer row with
`controlTotals`. Editable cells are `TextInput type="number" step="0.5"`.

**Interactions** Cell edit **[V]** → `PUT /hr/attendance/periods/:id/records/:employeeId` on
blur, one row per call. `payableDays` is **never** an input — it is the server's generated
column and renders as text. `422 DAY_IDENTITY_VIOLATED` marks the row red with the server's
expected/supplied figures and blocks Submit; `dayIdentityHolds: false` flags a row before any
save is attempted. Bulk upload **[I]** → `POST /api/v1/files`
(`purpose=ATTENDANCE_UPLOAD`, `contextId` = the period's cycle) →
`POST /hr/attendance/periods/:id/records:bulk`, whose row-level report renders as a rejection `DataTable`: valid rows
committed, rejected rows listed with `rowNo`, `employeeNumber`, `reason`, `message`. Nothing is
silently coerced, and the report is not dismissible until acknowledged.

**Permission gate** `attendance:capture` @ `ORG`. **HR only.**

#### 6.15.1 The manager's slice — `/approvals/attendance/:approvalId`

A **separate route and a separate component tree**, not this screen with a flag. It reuses the
same `DataTable` columns and the same control-total footer, so it looks identical, but it is
gated on `attendance:approve:team` @ `DIRECT_REPORTS` and it calls different endpoints.

**Layout** Header: the period label, the `StatusChip`, and "{n} people in your slice" from
`page.total`. Then the read-only `DataTable` (every cell text, no `TextInput`), the
`controlTotals` footer for the slice, and a decision panel.

**Fields** `GET /manager/attendance/approvals` → the list (also surfaced as
`ATTENDANCE_APPROVAL` tasks on `/approvals`); `GET /manager/attendance/approvals/:id/records`
→ `data[]` (`AttendanceRecordDto`, cursor-paginated), `controlTotals`, `period`, `decision`,
`version`.

**Interactions** Approve **[I][V]** → `POST /manager/attendance/approvals/:id/decide`
`{outcome: 'APPROVE'}`; Return **[I][V]** → `{outcome: 'RETURN', note}` with a note of at
least 10 characters. Nothing on this screen writes a record: a manager who disagrees with a
day count **returns the slice to HR with the reason**, which is the workflow's own correction
path and the reason the cells are not editable here. A returned slice reopens the period for
HR (`WORKFLOWS.md`), and the screen says so in the success toast, from the response.

`409 GUARD_FAILED` renders the server message — most often that the period moved on while the
manager was reading. `403` after a reporting-line change renders `forbidden` rather than a
blank grid.

**Empty / Error** §4.15b. **Permission gate** `attendance:approve:team` @ `DIRECT_REPORTS`. There is
no escalate control here; HR escalates a stalled slice with
`POST /hr/attendance/approvals/:id/escalate` from §6.14.

### 6.16 HR · Employees, Policy admin, Announcement admin, Letters, Tickets

| Screen                                            | Layout                                                                   | Key endpoints                                                                                                                                                                                                                                                                                    | Notable rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Employees** `/hr/employees`                     | Directory grid + filters (department, location, status, q); `Pagination` | `GET /hr/employees`, `POST /hr/employees` **[I]**, `PATCH /hr/employees/:id` **[V][S]**, `POST /hr/employees/:id/invite` **[I]**, `POST /hr/employees/:id/deactivate` **[I][S]**, `POST /hr/employees/:id/documents` **[I]**                                                                     | Gated on `employee:read:any` @ `ORG` (§1.2) — **not** `profile:read:team`, which a Manager holds at `REPORTING_CHAIN` and would otherwise use to mount this screen. Bank and statutory sections are **not** on the HR screen (`SECURITY.md` §4.4: HR cannot see full bank numbers). Deactivate requires a reason and step-up                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Employee detail** `/hr/employees/:id`           | My profile layout                                                        | `GET /hr/employees/:employeeId`                                                                                                                                                                                                                                                                  | Masked values only; **no unmask control is rendered at all** for HR on bank/statutory — not a disabled one, because a disabled control advertises a capability that does not exist. Emergency contacts are visible (`PROFILE_SECTION_SCOPE.emergency` is `REPORTING_CHAIN`, and HR holds `profile:read:self` @ `ORG`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Policy admin** `/hr/policies`                   | Policies split; right pane = version list + draft editor + review rail   | `GET/POST /hr/policies`, `POST /hr/policies/:id/versions` **[I]**, `PATCH /hr/policies/versions/:id` **[V]** (DRAFT only), then the review chain `POST /hr/policy-versions/:id/{submit-review,return,reassign,publish,withdraw}` **[I][V]**, and `POST /hr/policy-assignments/:id/waive` **[I]** | The editor writes `bodyMarkdown` (≤ 200 000 chars; the request cap is raised to 1 MiB on this route alone — `API.md` §13.13 — so the `FormCard` shows a live character counter and blocks at the cap rather than letting a 413 surprise the author), `summary`, `points[]` (≤ 20), `applicabilityRules[]` (1–50), and **exactly one** of `acknowledgementDueDays`/`acknowledgementDueOn` — a radio pair, never both enabled. **The version is a state machine, not a publish button:** `DRAFT → IN_REVIEW → PUBLISHED`, with `return`, `reassign` and `withdraw` as the other edges. The right pane renders `availableTransitions[]` from the version DTO exactly as the payroll `StepTracker` does (§6.17) and the client decides no transition itself. Publish shows the real `assignmentsCreated` / `assignmentsSuperseded` / `notificationsQueued` from the transaction. `409 SEGREGATION_REQUIRED` renders "You authored this version — a second HR approver must publish it." |
| **Change requests** `/hr/profile-change-requests` | Approvals queue layout: rows left, the requested-vs-current diff right   | `GET /hr/profile-change-requests`, `POST …/:id/claim` **[I]**, `POST …/:id/approve` **[I][S]**, `POST …/:id/reject` **[I]** (`reason` ≥ 10)                                                                                                                                                      | The diff shows `fields[]` as `label · current (masked) → requested`. **The current value stays masked** even here: approving a bank change never requires HR to read the old account number, and the endpoint does not return it. Approve is step-up because it writes a statutory or bank field                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Policy compliance**                             | Tile row (assigned / acknowledged / pending / overdue) + table           | `GET /hr/policies/versions/:id/compliance`                                                                                                                                                                                                                                                       | Summary is the server's `GROUP BY` and the four tiles are four `MetricDto`s. The **only** client-computed number in the whole application is this screen's bar width, `round(acknowledged / assigned * 100)`, hidden entirely when `assigned === 0` (§2.7 rule 4). The table's per-employee rows carry `acknowledgedAt`, `dueOn` and `status` as persisted fields — Directive 7's evidence, rendered not derived                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Announcement admin** `/hr/announcements`        | Announcements split; composer replaces the reader                        | `POST /hr/announcements`, `PATCH` **[V]** (DRAFT only), `POST …/publish` **[I]**, `/pin`, `/unpin`, `/archive`                                                                                                                                                                                   | Audience builder writes `announcement_audience` rows; publish reports the real `notificationsQueued`. A future `publishAt` shows the persisted `SCHEDULED` state, not a client timer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Letters & records** `/hr/documents`             | Queue table (left, `formCols`) + issue form (right)                      | `GET /hr/document-requests`, `POST …/:id/issue` **[I][S when the template includes salary]**, `POST …/:id/reject`, `POST /hr/employees/:id/documents` **[I]**                                                                                                                                    | Overdue rows are flagged from `dueAt`, which was computed against the holiday calendar server-side                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Ticket queue** `/hr/tickets`                    | Help-desk list as a `DataTable` + a thread pane                          | `GET /hr/tickets`, `POST /hr/tickets/:id/assign` **[I]**, `POST /hr/tickets/:id/comments`, `POST /hr/tickets/:id/resolve` **[I]**                                                                                                                                                                | The thread shows `INTERNAL` comments to HR only — they are excluded by the employee query and by RLS, never hidden client-side. A `notificationEmailStatus = 'FAILED'` renders the §4.15 banner, whose Retry is gated on **`ticket:assign`** (the earlier draft named `ticket:assign`, which is not a member of `Permission` and would not compile)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### 6.17 Accounts · Payroll cycles (`/accounts/payroll`, `/accounts/payroll/:cycleId`)

**Layout** `ListDetailSplit grid="split"`. Left: cycle rows (label, period, `StatusChip`).
Right, in order:

1. **Step tracker** — seven rows from `stepTracker[]`, each a check/current/blocked/pending
   glyph, the label, the owner, and `blockedReason` when blocked. This is the mandated workflow
   made visible: _Accounts uploads → HR submits attendance → Managers approve → system validates
   → payroll generated → second Accounts approver → published_.

   **The tracker is rendered, never computed.** The seven rows, their labels, owners, order and
   states all come from `stepTracker[]`; the SPA holds no array of step names and no mapping
   from `cycle.status` to a step index. That matters because the state machine is
   `WORKFLOWS.md`'s, not this screen's: a new step, a renamed step or a changed guard must not
   require a frontend release, and — more importantly — a client-side status→step map is a
   second, divergent copy of the rule that decides whether payslips exist. `state` is
   `DONE | CURRENT | BLOCKED | PENDING`; an unrecognised value renders as `PENDING` with the
   server's label and no glyph, rather than dropping the row.

2. **Control totals** — three `MetricTile`s (Gross / Deductions / Net), `—` until `CALCULATED`.
3. **Counts** — `employeeCount`, `payslipCount`, `attendancePeriod.status`.
4. **Actions** — one `Button` per entry in `availableTransitions[]`, labelled by the server,
   disabled when `guardsSatisfied` is false with `blockingReason` as the disabled reason.
   The client never decides which transition is legal.

**Interactions** Every action is `POST /payroll/cycles/:id/<verb>` **[I][V]**, with **[S]** on
`approve` and `publish`. The verb, its label and whether it is currently legal all come from
`availableTransitions[]`; the SPA renders one `Button` per entry and **never** synthesises a
transition the server did not offer. A transition with `guardsSatisfied: false` renders
disabled with `blockingReason` as its `disabledReason` — visible, not hidden, because "you
cannot publish yet, managers have not approved attendance" teaches the workflow and a missing
button does not.

`publish` opens a confirmation `Modal` first — a two-step confirm because publication is the
irreversible act that makes payslips visible to every employee in the cycle. The modal restates
the cycle label, the period, and `employeeCount` from the **already-loaded** cycle DTO; it does
**not** predict how many payslips will be published. The success toast reads
"{res.publishedPayslipCount} payslips published" from the response — the real, persisted
count, after the fact. `409 SEGREGATION_REQUIRED` renders the server's `requires` text naming
the second approver.

While `status ∈ {VALIDATING, CALCULATING}` the cycle query polls every 5 s (bounded per
§1.4.3) and the actions are disabled with "Running…", announced once in the
`aria-live="polite"` async-status region of §7.4.

**Empty / Error** §4.16. **Permission gate** route `payroll:cycle:read` @ `ORG`; each action
carries its own seeded code — `payroll:cycle:create`, `payroll:validate`, `payroll:calculate`,
`payroll:approve`, `payroll:publish`, `payroll:close`, `payroll:cycle:transition` (cancel,
open-inputs, lock-inputs, defer) and `payroll:input:upload` — all @ `ORG`. HR holds **only** `payroll:cycle:read`, so HR
sees the tracker, the control totals and the step states — which is the point, since HR needs
to know when its attendance submission is due — and **no** action button at all. The buttons
are absent rather than disabled for HR: a disabled Publish on an HR screen implies HR could
ever publish, which is exactly the segregation the design exists to enforce.

### 6.18 Accounts · Payroll inputs (`/accounts/payroll/:cycleId/inputs`)

**Layout** Header with the cycle label + `StatusChip`; an **Upload** `FormCard` (`FileField`
accepting CSV/XLSX, an optional declared control total, a note); a **Batches** `DataTable`
(batch no · filename · rows total/valid/rejected · declared vs parsed total · status · actions);
a **Rejections** table for the selected batch; and a **Lock inputs** panel.

**Interactions** `POST /api/v1/files` (`purpose=PAYROLL_INPUT_UPLOAD`, `contextId` = the
cycle id, ≤ 25 MiB, CSV/XLSX) → `POST /payroll/cycles/:id/input-batches` **[I]**. The
response's `rejections[]` and `parseErrors[]` render immediately, with `rowNo`,
`employeeNumber` and the exact message — the traceability link back to the uploaded line, and
the reason nothing is ever silently coerced. `commit` **[I][V]** requires declared = parsed
(`422 CONTROL_TOTAL_MISMATCH` renders both figures side by side, neither of them recomputed
client-side). `DELETE` marks the batch `DISCARDED`, never a hard delete, and the UI says so.

**Lock inputs** **[I][V]** → `POST /payroll/cycles/:id/lock-inputs`. This is workflow step 1
completing, and its toast says exactly that — "Inputs locked · People Ops can now submit
attendance for {period}" — because it is the transition that clears HR's `submitBlockers[]`
(§6.14). It invalidates `['attendance']` as well as `['payroll']` (§1.4.4) so an HR user with
the other screen open sees the blocker lift on their next focus.

Item amounts are visible only to `payroll:input:upload` holders and every such read is a
`READ_SENSITIVE` audit event — the screen shows a one-line notice to that effect, so the
operator knows the read is recorded before they make it.

### 6.19 Accounts · Validation report (`/accounts/payroll/:cycleId/validation`)

**Layout** Header + a "Run validation" `Button primary` **[I][V]**; a severity summary row
(three `MetricTile`s: Errors / Warnings / Info, from the `summary` object); a filter row
(severity, unresolved only, pass no.); a results `DataTable` (rule code · severity chip ·
employee · message · resolved). Selecting a row opens a detail panel with `detail` and a
resolve form.

**Interactions** `POST /payroll/cycles/:id/validate` **[I][V]** — refused with
`409 GUARD_FAILED` while attendance is not `APPROVED`/`LOCKED`, and the screen renders that
message rather than a generic error, so the operator sees _which_ upstream step is incomplete.
Resolve **[P]** `payroll:validate` → `POST …/validation-results/:id/resolve` with a note
of at least 10 characters; the note is audited. Messages are already redacted server-side —
the client does not attempt to enrich them with amounts.

### 6.20 Accounts · Payslip register and Reimbursements

**Register** (`/accounts/payroll/:cycleId/register`) — a `DataTable` of employee · number ·
payable/total days · gross · deductions · net · reference · status, with the cycle's
`controlTotals` in the footer. Cursor-paginated, sorted by `employee_number` server-side. Every
read is `READ_SENSITIVE`; the screen shows the notice and offers no client-side export (exports
go through `POST /admin/audit/export`-style audited endpoints only).

**Reimbursements** (`/accounts/reimbursements`) — the Expenses screen recomposed: three
`MetricTile`s (Finance-approved unpaid / In draft batches / Paid this FY), a batch
`DataTable`, and a batch detail with a claim picker. Create **[I]**
`POST /accounts/reimbursement-batches {cutoffDate}`; add items
`POST …/items {expenseClaimIds}` (a `409 GUARD_FAILED` lists the offending `claimNos`
verbatim); `lock`; then `send-to-payroll {payrollCycleId}` **[I]**, guarded on the cycle being
`INPUTS_OPEN`. The screen states that claims become `REIMBURSED` when that cycle publishes —
which is a join, not a caption.

### 6.21 Compliance · Audit log (`/audit`)

**Layout** `ListDetailSplit grid="split" align="start"`: a filter bar (date range, actor,
action, entity type, request id), an event list, and a detail pane showing the redacted
`beforeData`/`afterData`, the `requestId`, and the chain position. A "Verify chain" button
(`audit:verify`) calls `GET /admin/audit/chain/verify` and renders the result as a
`tone="positive"` or `tone="danger"` banner with the checkpoint details. Export **[I][S]** →
`POST /admin/audit/export`, rate-limited to 3/h with one concurrent job; the UI disables the
button and shows the server's `Retry-After` countdown rather than letting the user hammer it.

### 6.22 Authentication screens (outside the shell)

These screens were listed in §1.1 and §1.2 from the first draft but never specified, which
left the highest-risk surface in the application to an implementer's judgement. They are
specified here in full.

**Shared chrome.** A centred `Card padding="roomy"`, `max-inline-size: 420px`, on
`--surface-page`, with the **bundled** logo above it and no other network-dependent element.
No shell, no nav, no search, no notifications. `<h1>` is the screen name. One `FormCard`
`errorBanner` slot, `role="alert"`, carries every failure. Nothing on these screens renders a
value from the database except what the user just typed.

**The rule that governs all of them: never confirm or deny an identity.** Every failure of
login, password reset and invitation acceptance renders the **same** message and takes the
same visible time, regardless of whether the account exists, is locked, is unknown, or the
password was wrong. The API is built the same way (`POST /auth/password-reset/request` always
returns `202`); the SPA must not undo it by branching on a code. The three codes the SPA
_does_ branch on are `423 ACCOUNT_LOCKED` (the server chose to reveal a lockout, with a
`Retry-After`), `403 MFA_ENROLMENT_REQUIRED` and `403 PASSWORD_CHANGE_REQUIRED` — all of which
are post-authentication.

#### 6.22.1 `/login` — `LoginRoute`

| Element            | Source / behaviour                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email              | `TextInput type="email"` `autoComplete="username"`, `inputMode="email"`, required                                                                                                                                                                                         |
| Password           | `TextInput type="password"` `autoComplete="current-password"`, required, with a show/hide `IconButton` (`aria-pressed`)                                                                                                                                                   |
| Submit             | `POST /auth/login {email, password}` — **no** `Idempotency-Key` (login is not idempotent by design; `API.md` §9 excludes it)                                                                                                                                              |
| "Forgot password?" | `LinkButton variant="ghost"` → `/password/reset`                                                                                                                                                                                                                          |
| `?reason=`         | `expired` → "Your session ended. Please sign in again."; `idle` → "You were signed out after 30 minutes of inactivity."; `revoked` → "You were signed out. If this was not you, contact IT." Copy is local (it describes the client's own behaviour) and contains no data |

Outcomes, all handled here and nowhere else:

| Response                       | Behaviour                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200` with `mfaRequired: true` | Hold `mfaToken` **in memory** (never the URL, never storage), navigate to `/login/mfa`, preserving `?next=`                                                                         |
| `200` with tokens              | `setAccessToken` + `setCsrfToken`, then `navigate(safeNext(searchParams.next) ?? '/', {replace: true})`                                                                             |
| `401 INVALID_CREDENTIALS`      | The single generic message. The form does **not** clear the email; it clears the password                                                                                           |
| `403 MFA_ENROLMENT_REQUIRED`   | → `/login/mfa/enrol` with `enrolmentToken` in memory. Forced for `MANAGER`/`HR`/`ACCOUNTS` (`MFA_REQUIRED_ROLES`)                                                                   |
| `403 PASSWORD_CHANGE_REQUIRED` | → `/password/forced-change` with `details.changeToken` in memory                                                                                                                    |
| `423 ACCOUNT_LOCKED`           | Banner with the `Retry-After` countdown; the submit button is disabled for that long, from a single `setInterval` that is cleared on unmount                                        |
| `429 RATE_LIMITED`             | Same countdown treatment. Rate limits are `ip` 10/15 min, `account` 10/15 min, spray `ip` 60/60 min (`API.md` §14) — the SPA does not restate the numbers, it renders `Retry-After` |

`safeNext()` is §8.6's open-redirect guard: a value is accepted only if it starts with exactly
one `/`, is not `//` or `/\`, and resolves to a known route; otherwise `/`.

#### 6.22.2 `/login/mfa` — `MfaChallengeRoute`

Six-digit `TextInput` `inputMode="numeric"` `autoComplete="one-time-code"` `maxLength={6}`,
auto-submitting on the sixth digit and on paste. `POST /auth/mfa/challenge {mfaToken, code}`.
A "Use a recovery code" toggle swaps the field for an alphanumeric one and posts
`{mfaToken, recoveryCode}`. Landing here without an `mfaToken` in memory (a refresh, a pasted
URL) redirects to `/login` — the token deliberately does not survive a reload. `429` shows the
cooldown (`5/5 min` then a 15-minute lockout, rendered from `Retry-After`).

#### 6.22.3 `/login/mfa/enrol` — `MfaEnrolRoute`

`POST /auth/mfa/enrol` returns the secret and an `otpauthUri`. The QR code is rendered
**client-side** from that string into an inline `<svg>` by a dependency with no network access
— never an image URL from a QR service, which would leak an MFA secret to a third party and
would be blocked by `img-src 'self' blob:` anyway. The secret is also shown as selectable text
for manual entry. Confirm with `POST /auth/mfa/verify-enrolment {code}`; on success the
**recovery codes are displayed once**, with a Download (a `Blob`, `text/plain`, via the same
anchor mechanism as §8.5) and a Copy, and a mandatory "I have saved these codes" checkbox
before Continue. They are never re-fetchable and the screen says so. Both routes require
`reauth` (`API.md` §4.3), so arriving here from `/security` raises `<ReauthDialog>` first.

#### 6.22.4 `/password/reset` and `/password/reset/confirm` — `PasswordResetRoute`

Request: email → `POST /auth/password-reset/request`. The response is **always** `202` and the
screen **always** renders the same confirmation panel ("If that address belongs to a Widedrop
account, we have sent a link"). There is no error branch, because a branch would be an oracle.

Confirm: reads the token from the URL, posts `POST /auth/password-reset/confirm {token,
newPassword}`. The token is consumed on submit and the SPA replaces the URL
(`history.replaceState`) to strip it before the next render, so it does not sit in the address
bar, the back stack or a screenshot.

**Password field, both screens.** `autoComplete="new-password"`, a confirmation field, and a
strength meter driven by the **shared** policy object in `@widedrop/shared` (minimum length,
the breached-password check is server-side only). The meter is advisory; the server's `422`
`fieldErrors` are authoritative and are rendered per field. The policy's own text is rendered
from the shared constant so the client and server can never state different rules.

#### 6.22.5 `/password/forced-change` — `ForcedPasswordChangeRoute`

`POST /auth/password/forced-change {changeToken, newPassword}`. Reached only from a
`403 PASSWORD_CHANGE_REQUIRED`, with the token in memory. It is **not** dismissible: there is
no link away, and `RequireAuth` will bounce any attempt to route elsewhere while the flag is
set. On success the user is returned to `/login` with a success banner — the change token
authorises no session.

#### 6.22.6 `/invitation/accept` — `AcceptInvitationRoute`

`POST /auth/accept-invitation {invitationToken, newPassword, acceptTerms}`. The token comes
from the URL and is stripped by `replaceState` on mount. `acceptTerms` is an unchecked
`Checkbox` whose label links to the published policy set; it is required, and the API records
the acceptance. Errors are generic apart from `410 GONE` ("This invitation has expired — ask
People Ops to send a new one"), which reveals nothing about whether an account exists.

#### 6.22.7 Empty / Loading / Error

There is no empty state on an auth screen — there is no collection. Loading is the submit
button's inline spinner only. Errors are the banner. A network failure renders the banner with
"We could not reach Widedrop. Check your connection and try again", never a logout and never a
retry loop.

### 6.23 Security — `/security` (`SecurityRoute`, every persona)

Reached from the user menu, from the More sheet, and from the `MFA_ENROL` /
`MFA_RECOVERY_LOW` to-dos on Home. Not in the nav manifest (§5.1).

**Layout** Column, gap 22px, three `Card`s using the Benefits card treatment.

| Card                      | Fields                                                                                                     | Actions                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Two-step verification** | `GET /auth/mfa/status` → `isEnrolled`, `credentials[]` (`label`, `createdAt`, `lastUsedAt`), `mustReEnrol` | "Set up" → §6.22.3 · "Remove" `DELETE /auth/mfa/credentials/:id` **[R]**, refused by the server while the user's roles require MFA                                                          |
| **Recovery codes**        | `recoveryCodesRemaining` (a count, from the same endpoint)                                                 | "Generate new codes" `POST /auth/mfa/recovery-codes` **[R][I]** — shown once, same display rules as §6.22.3; the previous set is invalidated and the screen says so before the user commits |
| **Password**              | `passwordChangedAt`                                                                                        | "Change password" `POST /auth/password/change` **[R][S]** (both re-auth **and** step-up, `API.md` §4.3)                                                                                     |
| **Active sessions**       | `GET /auth/sessions` → `data[]` (`deviceLabel`, `ipCity`, `lastSeenAt`, `isCurrent`)                       | "Sign out everywhere" `POST /auth/logout-all` **[I]**, then `hardLogout('revoked')` locally. Individual rows are informational in v1                                                        |

Every value on this screen is a persisted fact; `recoveryCodesRemaining` is a `COUNT` and is
rendered as `0` when it is measured zero (that is the one case where a zero is the truth and
the empty state, §4.15c, carries the action). `mustReEnrol: true` renders an amber banner with
the server's reason above the MFA card.

**Permission gate** `profile:read:self` @ `SELF` — every persona has it, and every persona needs
this screen. There is no admin view of anyone else's credentials here; MFA reset for another
person is an HR action on `/hr/employees/:id`, audited, and it lives there.

---

## 7. Accessibility

Target: WCAG 2.2 AA. The checks below are enforced by `vitest-axe` on every screen test and by
a Playwright + `@axe-core/playwright` pass per route in CI; a violation fails the build.

### 7.1 Landmarks and headings

- One `<header>` (the top bar or mobile header), one `<nav aria-label="Main">` (sidebar), one
  `<main id="main">`, one `<nav aria-label="Sections">` for the compact `TabBar`.
- A "Skip to content" link is the first focusable element, visually hidden until focused,
  targeting `#main`.
- Exactly one `<h1>` per screen — the page title. Card titles are `<h2>`; sub-sections `<h3>`.
  `SectionHeader` takes `as` so a card inside a section does not skip a level.
- Route changes move focus to the `<h1>` (`tabIndex={-1}`, focus on mount) and announce the new
  title through a visually hidden `aria-live="polite"` "Navigated to {title}" region. Without
  this an SPA navigation is silent for a screen-reader user.

### 7.2 Keyboard navigation

| Surface                       | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sidebar**                   | A single tab stop per nav group is wrong here — the prototype's items are buttons in a list, so each is tabbable, in DOM order, and `aria-current="page"` marks the active one. Groups are `<ul role="list">` with an `aria-labelledby` pointing at the group label                                                                                                                                                                                                                                                                                                                                                                                      |
| **TabBar**                    | Roving tabindex: one tab stop; Left/Right move, Home/End jump, Enter/Space activate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **SegmentedTabs**             | `role="tablist"` + `role="tab"`/`aria-selected` + `role="tabpanel"` with `aria-labelledby`; Left/Right/Home/End move focus. **Activation is `manual` by default and `automatic` only where `activation="automatic"` is passed.** Automatic activation fires the panel's query for every tab the user arrows past — on My profile that is four network requests to reach the fourth tab, and on Approvals it refetches a queue. `automatic` is therefore used **only** for the Approvals pending/history pair, whose two queries are already in cache; every other tab strip (profile, employee detail, payroll) is manual, activating on `Enter`/`Space` |
| **MoreSheet / Modal / Sheet** | Focus is trapped (`useFocusTrap`), `aria-modal="true"`, `role="dialog"`, `aria-labelledby` the title. Escape closes (except the non-dismissible step-up dialog). Focus returns to the invoking control. Background content gets `inert` where supported, `aria-hidden` otherwise                                                                                                                                                                                                                                                                                                                                                                         |
| **GlobalSearch**              | `role="combobox"` on the input with `aria-expanded`, `aria-controls`, `aria-autocomplete="list"`; the dropdown is `role="listbox"` with `role="option"` children and `aria-activedescendant`. Down/Up move, Enter selects, Escape closes and restores the query, Tab closes without selecting                                                                                                                                                                                                                                                                                                                                                            |
| **NotificationPopover**       | `role="dialog"` anchored to the bell, focus moved to the heading on open, Escape closes, Tab cycles within, focus returns to the bell                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **DataTable**                 | Native table semantics; when `onRowActivate` is set the first cell contains a real `<button>` so the row is reachable and announced — the whole row is never a click target without a focusable element                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Accordion**                 | Each question is a `<button aria-expanded aria-controls>`; the panel is a region labelled by it. Up/Down move between headers, Home/End jump                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **ListDetailSplit**           | The list is `role="listbox"`-free: rows are buttons with `aria-current="true"` on the selected one, and the detail pane has `aria-live="polite"` on its heading so a selection change is announced                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Every interactive element is a real `<button>`, `<a>`, `<input>` or `<select>`. There is no
`onClick` on a `<div>` anywhere; ESLint `jsx-a11y` enforces this with no disables permitted.

### 7.3 Focus visibility

`:focus-visible { box-shadow: var(--focus-ring) }` — a 2px `--surface-shell` spacer plus a 4px
`--accent` ring, which clears 3:1 against every surface token. `outline: none` without a
replacement ring is banned by a CSS lint rule. Focus is never removed on mouse users via
`:focus { outline: none }`.

### 7.4 Live regions

| Region              | Politeness                 | Content                                                             |
| ------------------- | -------------------------- | ------------------------------------------------------------------- |
| Toast viewport      | `polite`, `aria-atomic`    | The toast message. A toast is never the only notice of an error     |
| Form error banner   | `role="alert"` (assertive) | The `FormCard` error banner, announced on appearance                |
| Route announcer     | `polite`                   | "Navigated to {title}"                                              |
| Pagination summary  | `polite`                   | "Showing 1–25 of 214 people"                                        |
| Async action status | `polite`                   | "Validation running", "Payroll calculating" on the Accounts screens |

Only one assertive region exists (the form banner). Nothing polls into a live region.

### 7.5 Tables

`<caption>` on every `DataTable`, visually hidden, stating what the table contains and its
sort. `<th scope="col">`; row headers `<th scope="row">` for the employee column of the
attendance grid. `aria-sort` on sortable headers. Numeric columns use
`font-variant-numeric: tabular-nums` and are right-aligned, matching the prototype's money
columns. The stacked (mobile) presentation keeps `<table>` markup and uses CSS to reflow, so
semantics survive.

### 7.6 Status is never colour alone

`StatusChip` always renders the text label beside the tone; the tone is decoration. The Home
to-do dots, the notification dots and the payroll step glyphs each pair colour with a shape:
a filled dot plus the text ("Due 15 Oct"), a check for done, a slash for blocked, an outline
for pending. The Directory avatar colour is decorative (`aria-hidden` when a name is adjacent)
and carries no meaning.

### 7.7 Contrast, verified against the dark palette

Verified pairs (WCAG AA needs 4.5:1 for body text, 3:1 for large text and UI boundaries):

Ratios below are the values `contrast.test.ts` computes from `@widedrop/shared` tokens with
the WCAG 2.x relative-luminance formula, rounded to two decimals. They are **recomputed, not
transcribed** — an earlier draft carried hand-estimated figures that were wrong by up to 1.5
points in both directions, which is how a "verified" table stops being verification. The
**Floor** column is what the test asserts; the ratio must be ≥ the floor.

| Pair                                             | Ratio | Floor | Use                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ----- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--text` #F2F5FA on `--surface-shell` #0F1622    | 16.59 | 4.5   | Body                                                                                                                                                                                                                                     |
| `--text` on `--surface-raised` #172236           | 14.57 | 4.5   | Card body                                                                                                                                                                                                                                |
| `--text-bright` #D6DEEA on `--surface-raised`    | 11.75 | 4.5   | Policy / announcement body copy                                                                                                                                                                                                          |
| `--text-secondary` #A9B4C7 on `--surface-raised` | 7.61  | 4.5   | Secondary text                                                                                                                                                                                                                           |
| `--text-muted` #7C8AA3 on `--surface-raised`     | 4.57  | 4.5   | Meta text — passes, and is therefore permitted at 12px. **The margin is 0.07**, so any darkening of this token or lightening of that surface breaks AA; the test is the guard                                                            |
| `--text-muted` on `--surface-panel` #121B2B      | 4.95  | 4.5   | Meta text inside the sidebar, top bar and inputs                                                                                                                                                                                         |
| `--text-dim` #5F6D86 on `--surface-raised`       | 3.05  | 3.0   | **Fails body contrast; passes the 3:1 large-text / non-text floor.** Permitted only for uppercase eyebrow labels ≥ 11px/500 that duplicate adjacent information, and for decorative glyphs. Never for a value, a status, or an only-copy |
| `--text-dim` on `--surface-shell`                | 3.47  | 3.0   | Same restriction                                                                                                                                                                                                                         |
| `--accent` #6EA8FF on `--surface-shell`          | 7.52  | 4.5   | Links, focus ring                                                                                                                                                                                                                        |
| `--accent` on `--surface-raised`                 | 6.60  | 4.5   | Ghost buttons inside cards ("View all", "Apply")                                                                                                                                                                                         |
| `--surface-on-accent` #0B1729 on `--accent`      | 7.45  | 4.5   | Primary button label                                                                                                                                                                                                                     |
| `--tone-green-fg` on `--tone-green-bg`           | 7.88  | 4.5   | Chip                                                                                                                                                                                                                                     |
| `--tone-amber-fg` on `--tone-amber-bg`           | 8.31  | 4.5   | Chip                                                                                                                                                                                                                                     |
| `--tone-red-fg` on `--tone-red-bg`               | 6.46  | 4.5   | Chip                                                                                                                                                                                                                                     |
| `--tone-blue-fg` on `--tone-blue-bg`             | 6.68  | 4.5   | Chip                                                                                                                                                                                                                                     |
| `--tone-gray-fg` on `--tone-gray-bg`             | 6.62  | 4.5   | Chip                                                                                                                                                                                                                                     |
| `--accent-pale` #CFE0FF on `--surface-selected`  | 9.10  | 4.5   | Avatar initials on a selected row                                                                                                                                                                                                        |
| `--text-invert` on `--surface-selected` #1B365D  | 12.12 | 4.5   | Selected nav item                                                                                                                                                                                                                        |
| `--border` #263247 on `--surface-raised`         | 1.24  | —     | Decorative divider only — never the sole indicator of a control's boundary; every input also has a distinct background (`--surface-panel`) against its container                                                                         |
| `--border-strong` #2F3D55 on `--surface-panel`   | 1.58  | —     | Same: emphasised divider and scrollbar thumb, never a control boundary on its own                                                                                                                                                        |

Two borders sit below 3:1 and are therefore **not** the boundary of any control. WCAG 2.2
SC 1.4.11 requires 3:1 for the visual boundary of a component only where that boundary is what
identifies the component; every input, button and card here is identified by a **background
change** as well — `--surface-panel` #121B2B inside `--surface-raised` #172236 is itself only
1.17:1, so the identifying signal is the pair of _label + control shape + focus ring_, and the
focus ring is `--accent` at ≥ 7.5:1 against every surface. This is a deliberate, recorded
trade against the prototype's visual language rather than an oversight; §10 carries it as a
risk with the one-token remedy (`--border` → `--border-strong` on control outlines, 1.58:1,
still short, or a new `--border-control` at ≥ 3:1 against both surfaces, which is the real fix
if an auditor insists).

`contrast.test.ts` recomputes every row from `@widedrop/shared` tokens and fails if a ratio
drops below its floor, so a future token tweak cannot silently break contrast. The
`--text-dim` restriction is enforced by a stylelint rule limiting that variable to a named
allowlist of classes.

### 7.8 Reduced motion

The three prototype keyframes (`rise`, `fade`, `sheet`) are driven by `--duration-*`, which
`@media (prefers-reduced-motion: reduce)` collapses to `1ms` (§2.2). In addition:

- `usePrefersReducedMotion()` makes the toast appear without translation and the sheet without
  slide (opacity only, at 1 ms), rather than snapping mid-transform.
- Skeleton shimmer is replaced by a static `--surface-hover` block.
- `scroll-behavior: smooth` on `<main>` is wrapped in `@media (prefers-reduced-motion: no-preference)`.
- No parallax, no auto-advancing content, no animation longer than 5 s anywhere in the app.

### 7.9 Other

- Zoom to 200% and 320px width are both supported: no horizontal page scroll, because every grid
  has `minmax(0, 1fr)` and the shell's breakpoints are container-driven.
- Touch targets are ≥ 44×44 CSS px on the `TabBar`, the More sheet and every `IconButton`
  (the prototype's `min-height:48px` / `40×40` plus padding).
- `lang="en-IN"` on `<html>`; currency and dates are formatted with `Intl` in that locale, which
  also gives correct Indian digit grouping (`₹1,27,560`).
- Every icon-only control has an `aria-label`; every `Avatar` standing alone has a `label`.
- Error messages are text, never an icon or a colour alone, and are programmatically associated
  with their field via `aria-describedby` + `aria-invalid`.

---

## 8. Client security

The server is the security boundary. Everything here is defence in depth and, where noted,
a hard requirement of the deployed CSP.

### 8.1 Credentials

- The access token lives in a module closure (§1.3). It is **never** written to `localStorage`,
  `sessionStorage`, IndexedDB, a cookie, the URL, React state, the query cache, or a log line.
  A unit test asserts `localStorage.length === 0` after a full login + navigation flow, and an
  ESLint rule bans `localStorage`/`sessionStorage` outside `lib/` (where there are no callers).
- **No code reads `document.cookie` at all.** Both cookies are `HttpOnly`, and both are set on
  `api-ess.widedrop.com` with the `__Host-` prefix, so the SPA's document on
  `ess.widedrop.com` could not read them even if they were not `HttpOnly`. The CSRF token is
  held in the `authSession` closure from the **response body** (§1.3). An ESLint rule bans
  `document.cookie` outright, with no allowlist — there is no legitimate caller.
- A full page reload deliberately loses the access token and re-derives it from the cookie. This
  is the point: an XSS payload that runs after load finds nothing durable to steal, and the
  refresh cookie it cannot read.
- `queryClient.clear()` on logout, on `SESSION_REVOKED`, on the 30-minute idle timeout, and on
  `visibilitychange` after **60 minutes** of background time (§1.3), so payslip and profile
  data do not linger in memory. The earlier "12 h" figure was arbitrary and is withdrawn: 12
  hours is longer than a working day, which defeats the purpose.
- No "remember me", no persisted query cache, no service worker caching API responses. The
  service worker, if added later, must exclude `/api/v1/**` by origin.

### 8.2 Nothing secret in the bundle

- Configuration reaches the app through build-time `import.meta.env.VITE_*` — exactly
  `VITE_API_BASE_URL`, `VITE_APP_ENV` and `VITE_BUILD_SHA` (`DEPLOYMENT.md` §2.1), all public
  values. There is **no** inline `<script>window.__ENV=…</script>`; that would need
  `script-src 'unsafe-inline'`.
- **`VITE_SENTRY_DSN` is not consumed by this build.** `DEPLOYMENT.md` §2.1 lists it, but the
  CSP's `connect-src` is `'self' https://api-ess.widedrop.com` and nothing else, so a browser
  SDK posting to `ingest.sentry.io` would be blocked at runtime — a silently broken error
  reporter is worse than none. **Client error reporting therefore ships disabled in v1.** If
  it is wanted, it goes to a `POST /api/v1/client-errors` route on the API origin — which
  already satisfies `connect-src`, already carries the request-id correlation, and is the only
  place the payload rules of §8.6 can be enforced server-side as well. That route **does not
  exist in `API.md` today** and must be added there before this is switched on; §10 records it.
  Until then `VITE_SENTRY_DSN` is unused and should be removed from `DEPLOYMENT.md` §2.1
  rather than left as a variable that looks wired up. Adding a third-party ingest host means amending
  `connect-src` in `SECURITY.md` §6.3, `DEPLOYMENT.md` §2.3 and §8.3 here, together, with the
  review recorded — which is exactly the friction that decision deserves.
- `.env` files are not committed; `VITE_` variables are set in the Netlify build environment.
  A CI grep fails the build if a bundle contains a string matching the API-key or private-key
  patterns, or the literal `widedrop` service credentials names.
- Source maps are uploaded to the error tracker and **not** served publicly
  (`build.sourcemap: 'hidden'`).
- The bundle contains no seeded operational data: no employee list, no salary figure, no policy
  text, no email address. `bundle.test.ts` greps `dist/` for every fixture identifier in the
  prototype (`WDT-01847`, `EXP-2291`, `HD-4821`, `WDT-PS-2608-1847`, `Priya Raghavan`,
  `Arjun Malhotra`, `Neha Kulkarni`, `HDFC`, `ICICI`, `AXYPR`, `PRAN`), for
  `widedroptech.com` and `widedrop.com` outside `VITE_API_BASE_URL`, and for `₹` followed by a
  digit. Every one of those is a value that must arrive from the API at runtime, and a hit is
  a build failure, not a warning.

### 8.3 The CSP the app must satisfy

Served by Netlify for `ess.widedrop.com` (`SECURITY.md` §6.3), enforced, not report-only, after
one release in report-only. The header is **generated** at build time by
`scripts/generate-headers.mjs` into `apps/web/dist/_headers`, with `${VITE_API_BASE_URL}`
substituted, so a preview deploy points at the staging API rather than production
(`DEPLOYMENT.md` §2.3). Production expands to:

```
default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'none';
style-src-elem 'self'; img-src 'self' blob:; font-src 'self';
connect-src 'self' https://api-ess.widedrop.com; manifest-src 'self'; worker-src 'self';
form-action 'none'; frame-ancestors 'none'; frame-src 'none'; base-uri 'none';
object-src 'none'; media-src 'none'; upgrade-insecure-requests;
require-trusted-types-for 'script'; trusted-types default;
report-uri https://api-ess.widedrop.com/api/v1/csp-report
```

accompanied by a second header on the same responses, without which `report-to` is inert:

```
Reporting-Endpoints: csp="https://api-ess.widedrop.com/api/v1/csp-report"
```

Three corrections an earlier draft of this section got wrong, all of which would have failed
the "character for character" test it proposed:

1. The report path is **`/api/v1/csp-report`**, matching the generated file; an earlier draft
   wrote `/csp-report`.
2. `report-to csp` belongs in the header **only when `Reporting-Endpoints` is also sent**;
   the generated header carries `report-uri` alone plus the separate `Reporting-Endpoints`
   header, and `csp.spec.ts` asserts that pairing rather than a bare directive.
3. `apps/web/public/_headers` does **not** exist. `DEPLOYMENT.md` §2.2 states that no header
   name may appear in both `netlify.toml` and `_headers`, and `_headers` is generated into
   `dist/`. A committed `public/_headers` would be copied verbatim into `dist/` and silently
   overwrite the generated one. The frontend's obligation is to run the generator in
   `postbuild` and never to hand-write the file.

What the frontend must do to live inside it:

| Directive                            | Frontend obligation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `style-src-attr 'none'`              | Zero `style` attributes (§2.1), verified in CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `style-src 'self'`                   | CSS Modules only; no runtime `<style>` injection; no CSS-in-JS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `script-src 'self'`                  | No inline script, no `eval`, no `new Function`. Vite: `build.modulePreload.polyfill = false`, no `@vitejs/plugin-legacy`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `font-src 'self'`                    | IBM Plex is self-hosted in `public/fonts` (already present). **No Google Fonts link at runtime**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `img-src 'self' blob:`               | Logos and avatars are same-origin or initials; `blob:` exists only for previewing a just-selected upload. No external image host, no gravatar                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `connect-src`                        | Exactly one API origin. Any analytics or error endpoint must be added here explicitly and justified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `form-action 'none'`                 | Every submission is `fetch`; no `<form action>` navigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `frame-ancestors 'none'`             | Plus `X-Frame-Options: DENY` for old clients                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `base-uri 'none'`                    | No `<base>` tag; relative URLs resolve against the document only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `require-trusted-types-for 'script'` | No `innerHTML`, no `outerHTML`, no `insertAdjacentHTML`, no `document.write`, no `Element.setAttribute` on an event handler. Because `lib/sanitize.ts` produces a **React element tree** and the codebase contains no HTML sink at all (§8.4), **the app creates no Trusted Types policy whatsoever**. `trusted-types default` in the header is therefore a belt-and-braces restriction on _which_ policy name could be created, not a licence for a permissive one; the allowlist would matter only if a dependency reached for a sink, and a violation is exactly the runtime error we want. A Playwright assertion confirms `window.trustedTypes.defaultPolicy === null` on every route |
| `connect-src` (again)                | Because `'self'` is `ess.widedrop.com` and the API is a different origin, **every** API call is cross-origin and preflighted. `apiClient` therefore keeps its header set small and stable (`Authorization`, `Content-Type`, `X-Request-Id`, `X-WD-CSRF`, `Idempotency-Key`, `If-Match` — the exact `Access-Control-Allow-Headers` list of `API.md` §1.2) so the `Access-Control-Max-Age: 600` preflight cache actually hits. A screen must not add a bespoke request header                                                                                                                                                                                                                |

`infra/netlify/netlify.toml` carries the non-CSP headers (HSTS, `X-Frame-Options`,
`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, the cache rules of §8.7) and
the **generated** `dist/_headers` carries `Content-Security-Policy` and
`Reporting-Endpoints`; no header name appears in both. `csp.spec.ts` fetches the deployed
`ess.widedrop.com` and asserts the `Content-Security-Policy` response header equals the string
above **after** substituting the environment's `VITE_API_BASE_URL`, directive by directive
(parsed and compared as a set, so directive order is not a false failure), and that
`Reporting-Endpoints` names the same origin.

### 8.4 Server-supplied rich text

Two fields are author-controlled Markdown: `policy_version.body_markdown` and
`announcement.body_markdown` (plus `faq.answer_markdown`). The API deliberately never sends
HTML.

The rendering policy in `lib/sanitize.ts`:

1. Tokenise with **`marked.lexer(src, { gfm: true, breaks: false })`**, which returns a token
   tree. `marked.parse()` — which returns an **HTML string** — is banned by an ESLint
   `no-restricted-properties` rule, because a string of HTML has to be injected somewhere to be
   useful, and that somewhere is the sink we are trying not to have. Inline content is
   tokenised with `marked.lexer`'s inline tokens, not re-parsed. This point is spelled out
   because "parse with `marked`, render to React" is not achievable via `marked`'s default
   output and an implementer following the earlier wording would have reached for
   `dangerouslySetInnerHTML` to bridge the gap.
2. Walk the token tree and emit a **React element tree**. `dangerouslySetInnerHTML` does not
   appear anywhere in the codebase; an ESLint rule bans it with no permitted disables. This makes
   the Trusted Types requirement trivially satisfied — there is no HTML sink, and therefore no
   policy to create (§8.3). A token of type `html` is emitted as its **raw text**, so
   `<script>alert(1)</script>` in a policy body renders as those visible characters.
3. An allowlist of node types: paragraph, heading (h3–h5 only, demoted so the page's heading
   order survives), strong, em, ul/ol/li, blockquote, code, pre, hr, table, and link. Everything
   else renders as its text content.
4. Links: only `https:` and `mailto:` schemes survive; every other scheme (notably
   `javascript:`, `data:`, `vbscript:`) is rendered as inert text. External links get
   `target="_blank" rel="noopener noreferrer nofollow"` and a visually hidden "(opens in a new
   tab)".
5. Images inside policy or announcement bodies are **not rendered** — `img-src` forbids external
   images, and an inline `data:` image is a fingerprinting and exfiltration vector. The API's
   `attachment` field is the supported way to ship a file.
6. A snapshot test feeds the renderer a corpus of hostile Markdown (HTML injection, protocol
   tricks, nested entities, oversized nesting) and asserts no element outside the allowlist and
   no non-allowlisted URL scheme is produced.
7. Length is bounded, and bounding interacts with acknowledgement. The server caps
   `body_markdown` at 200 000 characters (`API.md` §13.13), so a compliant response always
   renders in full. If a body nonetheless exceeds the cap — a future schema change, a
   non-conforming environment — the renderer stops at the cap, shows "Download the PDF to read
   the full policy", **and sets `isComplete: false` on its result**. §6.5 consumes that flag to
   **remove the acknowledge control entirely**. Truncating the text and still offering the
   button would record an acknowledgement of bytes the screen declined to show, which is the
   precise failure the hash exists to prevent. Announcements and FAQ answers have no
   acknowledgement, so truncation there is cosmetic.
8. Nesting is bounded: depth > 12 renders the remainder as plain text, so a pathological
   `>>>>>>…` body cannot exhaust the stack. Table rows are capped at 500 and list items at
   2 000, with the overflow rendered as text and a notice.

`policy.bodySha256` is echoed back on acknowledge. What that proves, stated precisely: the
acknowledgement is bound to **the exact version the server served this client**, the server
persists `acknowledged_body_sha256` alongside it so the acknowledged text is provable from the
audit trail afterwards, and a republish during the read is caught as `BODY_HASH_MISMATCH`
rather than silently acknowledging different text (§6.5). It does **not** prove a human read
the words — no client-side mechanism can, and the spec should not claim it. The scroll gate is
a usability nudge; the hash is the evidence.

### 8.5 File downloads

Every download goes through `lib/download.ts`:

1. `fetch(`${downloadUrl}?mode=json`, {headers: auth})` → **`200` with
   `{ url, expiresAt, filename, mimeType, sizeBytes }`** (`API.md` §11.2), or `409` with
   `details.reason` when the object is not ready.

   **`?mode=json`, not the `302`.** The API's default is a redirect to the object store, and
   an earlier draft had the SPA `fetch` it and follow. That does not work here and would have
   failed in production on day one: `fetch` follows redirects transparently, the redirect
   target is the S3/R2 host, and `connect-src 'self' https://api-ess.widedrop.com` (§8.3)
   blocks it — the request dies with a CSP violation, not a useful error. `redirect: 'manual'`
   does not help either, because the resulting response is opaque and `Location` is
   unreadable. `?mode=json` exists in the contract for exactly this reason, and it also lets
   the screen show a spinner and render a `409` as a message instead of a broken navigation.

2. The SPA then navigates a hidden anchor to `url` — a **navigation**, which is governed by
   `form-action`/`navigate-to`, not by `connect-src`, and which streams to disk rather than
   through memory: `a.href = url; a.rel = 'noopener noreferrer'; a.download = filename;
a.click(); a.remove()`. `a.download` is ignored for a cross-origin target, which is fine:
   the signed URL's baked-in `Content-Disposition: attachment; filename="…"` governs, it is
   server-sanitised, and it is the name the user gets. The client never invents one (the
   prototype's "Downloading Payslip_Aug-2026.pdf" toast is gone).
   The 120-second TTL means the anchor is clicked immediately, in the same task as the
   response — never stored, never queued behind a confirmation dialog.
3. The signed URL is never logged, never put in the query cache, never added to browser history
   (`window.open` is not used; the anchor is removed immediately after the click).
4. `409` with `details.reason ∈ {PDF_NOT_READY, ECARD_NOT_ISSUED}` disables the control with
   the server's message instead of failing silently. `404` means the artefact is out of scope
   or its file does not exist — `<ErrorState variant="notFound">` inside the card, never a
   retry loop. `429` (120 signed URLs per user per hour) disables with the `Retry-After`
   countdown.
5. Uploads: `FileField` checks the extension and size against `@widedrop/shared` `FILE_LIMITS`
   and `ACCEPTED_UPLOAD_TYPES` for immediate feedback, then posts multipart to
   `POST /api/v1/files`. **The client's check is convenience only** — the server sniffs the
   content type, scans the file, and can reject anything. A file whose `scanStatus` is not
   `CLEAN` cannot be attached, and the UI states that rather than queueing it.
6. Filenames rendered in the UI pass through `safeDisplayFilename()` from
   `@widedrop/shared`, which strips directory separators and control characters, so a hostile
   filename cannot spoof a path or inject bidi characters.

### 8.6 Other client-side controls

| Concern                 | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Clickjacking**        | `frame-ancestors 'none'`; no framebusting script is needed or shipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Open redirect**       | The `?next=` parameter on `/login` is accepted only when it starts with a single `/` and is not `//` or `/\`; otherwise the user lands on `/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Deep-link injection** | `toPath()` whitelists the screen id and encodes params (§1.8); a `deepLink` never becomes an `href` unvalidated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Clipboard**           | `navigator.clipboard.writeText` is used only for a work email, inside try/catch, and never for a token or a masked value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **`postMessage`**       | Not used. No `window.opener` is ever created (`rel="noopener"` everywhere)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Third-party scripts** | None. No analytics, no tag manager, no chat widget. Adding one requires a `script-src`/`connect-src` change and a review recorded in `SECURITY.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Dependency surface**  | The direct runtime dependencies are enumerated, not counted: `react`, `react-dom`, `react-router-dom`, `@tanstack/react-query`, `react-hook-form`, `@hookform/resolvers`, `zod`, `marked`, `@widedrop/shared`, and one QR renderer for §6.22.3 that must be offline-only (no network, no image host). **Ten.** Nothing else ships to the browser; a new runtime dependency is a reviewed change to this list. `npm audit --omit=dev` runs in CI and a high or critical finding fails the build; the lockfile is committed and `npm ci` is used                                                                                                                      |
| **Error reporting**     | Disabled in v1 (§8.2). If enabled, it posts to a `POST /api/v1/client-errors` route on the API origin — an endpoint `API.md` must first define — never to a third-party ingest host. The payload is an allowlist, not a denylist: `{ requestId, routeId, errorCode, httpStatus, buildSha, userAgent }` and nothing else. An allowlist is the correct shape here because a denylist over an unbounded object graph leaks the field someone forgot to name — and the objects in question are payslips. No stack frame containing a URL query string, no request body, no response body, no `Authorization`, no `Cookie`, no `X-WD-CSRF`, no breadcrumb of typed input |
| **Open windows**        | `window.open` is never called. Every external link is an `<a target="_blank" rel="noopener noreferrer nofollow">` produced by `lib/sanitize.ts`, which is also the only place a link's scheme is checked                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Idle & background**   | 30-minute idle logout, 60-minute background cache clear (§1.3) — the client-side half of "a payslip left open on a shared desk"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Client clock**        | `Date.now()` is banned outside `lib/serverTime.ts` and `lib/authSession.ts` by an ESLint rule. A tampered device clock therefore cannot make an expired declaration window look open or an overdue policy look current — those are server booleans (rule 6)                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Masked values**       | A masked string is display-only and is never submitted back as an input; `POST /me/profile-change-requests` rejects a value matching the mask pattern, and the client pre-empts that with a field error                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Autocomplete**        | `autoComplete="off"` on amount, date-of-spend and any field carrying another person's data; `autoComplete="username"` / `"current-password"` / `"new-password"` / `"one-time-code"` used correctly on the auth screens (§6.22)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Tokens in the URL**   | An `mfaToken`, `enrolmentToken`, `changeToken`, `invitationToken` or reset token is held in memory for the life of the screen and never written to the URL. A token that arrives in the URL (invitation, reset) is stripped with `history.replaceState` on mount, before the first paint that could be screenshotted and before it enters the back stack                                                                                                                                                                                                                                                                                                            |
| **Copy protection**     | There is none, and none is attempted. A user may copy their own payslip; pretending otherwise with `user-select: none` would break accessibility and stop nobody                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Session end**         | On `hardLogout` the cache is cleared and the URL is replaced (not pushed), so the back button cannot re-render a cached authenticated screen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### 8.7 What the frontend owes the deployment

`DEPLOYMENT.md` owns the Netlify site, the DNS and the API host. Four things inside that are
the frontend's to get right, and they are listed here because a build that gets them wrong
produces a site that looks deployed and behaves badly.

1. **Asset immutability and `index.html` freshness.** Vite emits content-hashed filenames into
   `assets/`; those are served `Cache-Control: public, max-age=31536000, immutable`.
   `index.html` is served `no-store, must-revalidate`. This pairing is what makes a CSP change
   or an asset-hash change reach a returning user on the next navigation instead of on cache
   expiry — and it is what makes the chunk-reload path of §1.3 a rare event rather than the
   norm.
2. **The SPA fallback must not shadow anything.** `/*  →  /index.html  200` is the last rule,
   after the explicit `/_headers`-adjacent paths, and the ESS site serves **no** `/api` path of
   its own — the API is a different origin, so there is nothing to proxy and no rewrite that
   could accidentally make a same-origin `/api/*` appear to work locally and fail in
   production. A deep link to `/accounts/payroll/:id/validation` must return `index.html` with
   `200`, not `404`, or every pasted link in the organisation breaks.
3. **Coexistence with `widedrop.com`.** The ESS is a **separate Netlify site on a dedicated
   host**, never a path of the marketing origin. `SECURITY.md` §7 explains why this is
   load-bearing rather than tidy: at `widedrop.com/ess` the SPA would be same-origin with every
   script, cookie and `localStorage` entry on the public site, and the `__Host-` cookie defence
   would be pointless. The frontend's obligation is to never introduce a same-origin
   assumption — no relative `/api` fetch, no cookie read, no `window.name` or `postMessage`
   contract with another Widedrop page. The marketing site's Netlify free tier is untouched by
   any of this.
4. **The build is reproducible and inspectable.** `npm ci`, Node pinned by `.nvmrc` and
   `netlify.toml`, `build.sourcemap: 'hidden'` (maps uploaded to the error store, never served
   — a served map hands an attacker the whole client, including every route and permission
   name), and `VITE_BUILD_SHA` rendered in the `<meta name="build">` tag so a bug report names
   the exact bundle. A preview deploy points at the staging API by construction (§8.3), so a
   preview can never write to production data.

---

## 9. Testing obligations for this spec

| Test                                                | Asserts                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.contract.test.ts`                           | Every token in `tokens.ts` exists in `tokens.css` and vice versa                                                                                                                                                                                     |
| `contrast.test.ts`                                  | Every pair in §7.7 meets its floor                                                                                                                                                                                                                   |
| `no-inline-styles.spec.ts` (Playwright, all routes) | `[style]` count is 0                                                                                                                                                                                                                                 |
| `csp.spec.ts`                                       | The served header equals §8.3 verbatim                                                                                                                                                                                                               |
| `useContainerBreakpoints.test.ts`                   | 880/820 thresholds, no redundant setState, `matchMedia` fallback                                                                                                                                                                                     |
| `nav.persona.test.ts`                               | The five nav trees of §5.2 and the tab-bar slots                                                                                                                                                                                                     |
| `emptyState.<screen>.test.tsx`                      | Each screen renders §4's copy with a zero-data fixture, and renders **no** number                                                                                                                                                                    |
| `authSession.test.ts`                               | Single-flight refresh, one replay, `hardLogout` on second 401, cache cleared                                                                                                                                                                         |
| `sanitize.test.ts`                                  | The hostile-Markdown corpus produces no disallowed node or scheme                                                                                                                                                                                    |
| `invalidation.test.ts`                              | Every mutation in §1.4.4 invalidates exactly its listed keys                                                                                                                                                                                         |
| `a11y.<screen>.test.tsx`                            | `vitest-axe` clean, focus order, live-region announcements                                                                                                                                                                                           |
| `bundle.test.ts`                                    | No fixture identifier, no `₹`-plus-digit, no `widedroptech.com`, no secret pattern in `dist/` (§8.2)                                                                                                                                                 |
| `apiPaths.contract.test.ts`                         | Every `METHOD /path` string in this document resolves against the endpoint list extracted from `API.md` §13 — the test that would have caught `/me/policies/:id/acknowledge` and `/me/profile/change-request`                                        |
| `queryKeys.contract.test.ts`                        | Every key's first segment is a declared module; every key's parameter object is the object the fetcher serialises                                                                                                                                    |
| `rbacWire.contract.test.ts`                         | `fromWire` is total over `GET /me`'s vocabulary; `toWire ∘ fromWire` is the identity (§5.4)                                                                                                                                                          |
| `navManifest.contract.test.ts`                      | `packages/shared` and the server enumerate the same screen ids; an unknown id is dropped, not thrown                                                                                                                                                 |
| `deepLink.test.ts`                                  | Every `SCREEN_PATHS` entry accepts the server's parameter names; the hostile-input corpus (`//evil.com`, `/\evil.com`, `javascript:`, absolute URLs, traversal) always yields a path starting with exactly one `/`; an unreachable screen yields `/` |
| `serverTime.test.ts`                                | No displayed value derives from `Date.now()`; a `YYYY-MM-DD` renders identically under `TZ=UTC`, `TZ=America/Los_Angeles` and `TZ=Asia/Kolkata` — the regression that turns 2 Oct into 1 Oct                                                         |
| `metricTile.test.tsx`                               | `isAvailable: false` renders `—` even with `value: 0`; a `MoneyDto` cannot be rendered under a non-`MONEY` unit (type-level)                                                                                                                         |
| `idempotency.test.ts`                               | The key is kept across a network error and a `5xx`, and regenerated on the first edit after a `422`                                                                                                                                                  |
| `apiClient.retry.test.ts`                           | A `POST` is never retried on `5xx`; a `GET` is retried twice; a `428` never replays a write                                                                                                                                                          |
| `csrf.test.ts`                                      | `X-WD-CSRF` is present on every unsafe method and absent on the cold-start `/auth/refresh`; `document.cookie` is never read                                                                                                                          |
| `auth.screens.test.tsx`                             | Login, reset and invitation render one generic failure for unknown-account, wrong-password and locked-without-`Retry-After`; no token reaches the URL or storage                                                                                     |
| `policyAck.test.tsx`                                | The acknowledge control is absent when `isComplete: false`; the scroll gate opens without `IntersectionObserver`; `BODY_HASH_MISMATCH` navigates and re-gates                                                                                        |
| `download.test.ts`                                  | `?mode=json` is used; the anchor is removed after click; a `409` disables rather than throws                                                                                                                                                         |
| `emptyStateCopy.test.ts`                            | No local fallback string in §4 matches `/\d/` outside the declared interpolation slots                                                                                                                                                               |
| `homePartial.test.tsx`                              | A key in `partial[]` renders a skeleton and fires the block query — never an empty state                                                                                                                                                             |

---

## 10. Open risks and recorded decisions

Items 1–4 were open questions in the first draft; three of them are now **decided** and the
decision is recorded here so it is not reopened by accident. Items marked **Risk** remain open.

1. **Decided — three permission vocabularies.** `packages/shared/src/rbac/roles.ts` uses
   `resource:action` (`policy:acknowledge:self`), `docs/SECURITY.md` §4.4 uses
   `verb:resource[:qualifier]` (`acknowledge:policy:self`), and `docs/API.md` §13 and
   `GET /me`'s `permissions[]` use `resource:verb:qualifier` (`policy:acknowledge:self`).
   **The SPA speaks the `packages/shared` spelling**, and the wire vocabulary is translated
   once at the `GET /me` boundary by `fromWire`/`toWire` (§5.4), covered by
   `rbacWire.contract.test.ts`. This is now an implementable position rather than a deferred
   choice: the SPA can be built today, and if the API's spelling is later unified the change is
   one file. **Risk that remains:** `API.md` §4.1 references two grants with no
   `packages/shared` counterpart — `directory:read_contact` (a conditional field, handled by
   field-presence in §6.10) and `approval:task:read:any` (HR-only, no screen in this document
   uses it). Both must gain shared-package members, or be documented as wire-only, before the
   RBAC matrix can be called complete.
2. **Decided — nav manifest drift.** The server filters and the client renders; an unknown
   screen id is **dropped and reported**, never rendered and never thrown (§6.0), and
   `navManifest.contract.test.ts` asserts both sides enumerate the same ids.
3. **Decided — "Compare regimes" is dropped** for want of a persisted source (§6.3). If the
   business wants it, it needs an `employee_tax_projection` row per regime and a new endpoint;
   it must not be computed in the browser. Unchanged.
4. **Decided — Home is no longer all-or-nothing.** `GET /me/home` gives each block a 400 ms
   budget and reports the ones that missed it in `partial[]`; the SPA renders those as
   skeletons and refetches them from their dedicated endpoints (§1.6, §6.1). The earlier
   framing of this as an open server-side question was simply out of date with `API.md` §13.2.
5. **Risk — client error reporting has no endpoint.** `DEPLOYMENT.md` §2.1 provisions
   `VITE_SENTRY_DSN`, but `connect-src` admits only the API origin, so a browser SDK would be
   blocked at runtime. The SPA ships with reporting **off** and with `console.error` plus the
   `requestId` surfaced in `<ErrorState>` as the support path. Switching it on requires a
   `POST /api/v1/client-errors` route in `API.md` with the allowlist payload of §8.6, or an
   explicit, reviewed `connect-src` amendment in three documents. Until one of those happens,
   a frontend crash is diagnosed from the user's `requestId` and the API's own logs — which is
   workable, and is why this is a risk rather than a blocker.
6. **Risk — the CSRF description in `API.md` contradicts `SECURITY.md`.** `API.md` §1.3, §4.2
   and the header table still describe `__Host-wd_csrf` as a _readable_ cookie echoed on three
   routes. `SECURITY.md` §3.4/§3.5 carries the correction, and this document follows
   `SECURITY.md` because the `API.md` version is not implementable across
   `ess.widedrop.com` → `api-ess.widedrop.com` (§1.3). **`API.md` must be amended before the
   API is built**, or the server will enforce CSRF on three routes while the client sends the
   header on all of them — which fails safe, but leaves every business write unprotected by
   the server-enforced half of the control.
7. **Risk — `--border` and `--border-strong` are below 3:1** against their surfaces (1.24 and
   1.58, §7.7). They are never the sole identifier of a control, and the focus ring is well
   above the floor, but an auditor may still raise SC 1.4.11. The remedy is a new
   `--border-control` token at ≥ 3:1 against both `--surface-raised` and `--surface-panel`,
   applied to inputs and secondary buttons only; it is a token addition, not a layout change,
   and it does alter the prototype's visual weight slightly, which is why it is not taken
   pre-emptively.
8. **Risk — `--text-dim` is 3.05:1** on `--surface-raised`. It clears the 3:1 non-text and
   large-text floor and is restricted by the §7.7 allowlist to uppercase eyebrow labels that
   duplicate adjacent information. Promoting eyebrows to `--text-muted` (4.57:1) is a
   one-token change that does not alter layout, and remains the fallback.
9. **Risk — attendance grid scale.** A 5 000-employee period in one cursor-paginated grid with per-row
   `PUT` on blur will be slow for bulk edits. The bulk-upload path is the intended mechanism; if
   inline editing at that scale becomes the norm, a batched `PATCH` endpoint is needed.
10. **Risk — container queries would be cleaner than the `ResizeObserver`.** They are now broadly
    supported, but the prototype's behaviour is specified in JS and two thresholds observe two
    different elements, one of which is an ancestor of the other. The observer is kept for exact
    fidelity; migrating to `@container` later is a mechanical change confined to §3.
