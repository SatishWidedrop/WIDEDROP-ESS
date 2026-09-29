# Widedrop ESS — Frontend Architecture and Screen Build Spec

**Status:** authoritative design contract for `apps/web`. An implementer follows this
document and makes no further interface decisions.

**Companion documents (read together, no duplication of truth):**

| Document                                                         | Owns                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design/prototype/prototype-markup.html` + `prototype-logic.jsx` | **The UI/UX source of truth.** Layout, order, copy tone, responsive behaviour                                                                                                            |
| `design/DESIGN-SYSTEM.md`                                        | Palette, type scale, geometry, nav model, empty-state pattern, locale                                                                                                                    |
| `docs/API.md`                                                    | The wire: paths, DTOs, statuses, headers, `emptyState` codes, screen→endpoint map                                                                                                        |
| `docs/DATA-MODEL.md`                                             | Tables, enums, state machines, guards                                                                                                                                                    |
| `docs/SECURITY.md`                                               | Auth primitives, RBAC matrix, CSP, masking, headers                                                                                                                                      |
| `docs/WORKFLOWS.md`                                              | State transitions, guards, notifications                                                                                                                                                 |
| **this document**                                                | Folder layout, routing, auth boundary, query/mutation conventions, the component API, responsive implementation, per-screen build spec, empty-state copy, accessibility, client security |

**The five rules this document never bends:**

1. **No fabricated data.** Every number, count, amount, status, balance and label on screen
   comes from an API response field named here, or from a pure formatter over one
   (`formatInr`, `formatDate`, `initials`). The SPA owns **no** operational constant. The
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
│   ├── auth/{LoginRoute,MfaChallengeRoute,MfaEnrolRoute,PasswordResetRoute}.tsx
│   ├── hr/{AttendancePeriodsRoute,AttendanceRecordsRoute,EmployeesRoute,EmployeeDetailRoute,
│   │       PoliciesAdminRoute,PolicyVersionRoute,PolicyComplianceRoute,AnnouncementsAdminRoute,
│   │       DocumentsAdminRoute,TicketQueueRoute}.tsx
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
│   ├── can.ts                        # cosmetic permission check — carries the "not a security control" comment
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

| Path                                          | Route component           | `screenId`          | Required permission                                                | Notes                                        |
| --------------------------------------------- | ------------------------- | ------------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| `/login`                                      | `LoginRoute`              | —                   | public                                                             | Outside the shell                            |
| `/login/mfa`                                  | `MfaChallengeRoute`       | —                   | public (`mfaToken` in memory)                                      | No cookie set yet                            |
| `/login/mfa/enrol`                            | `MfaEnrolRoute`           | —                   | public (`enrolmentToken`)                                          | Forced for `MANAGER`/`HR`/`ACCOUNTS`         |
| `/password/reset` · `/password/reset/confirm` | `PasswordResetRoute`      | —                   | public                                                             |                                              |
| `/`                                           | `HomeRoute`               | `home`              | `profile:read`                                                     | Index route                                  |
| `/payslips`                                   | `PayslipsRoute`           | `payslips`          | `payslip:read`                                                     | `?id=` selects the detail                    |
| `/tax`                                        | `TaxRoute`                | `tax`               | `tax:read`                                                         |                                              |
| `/profile`                                    | `ProfileRoute`            | `profile`           | `profile:read`                                                     | `?tab=personal\|employment\|bank\|emergency` |
| `/policies`                                   | `PoliciesRoute`           | `policies`          | `policy:read`                                                      | `?versionId=` selects the detail             |
| `/leave`                                      | `LeaveRoute`              | `leave`             | `leave:read`                                                       |                                              |
| `/benefits`                                   | `BenefitsRoute`           | `benefits`          | `benefit:read`                                                     |                                              |
| `/expenses`                                   | `ExpensesRoute`           | `expenses`          | `expense:read`                                                     | `?new=1` opens the claim form                |
| `/documents`                                  | `DocumentsRoute`          | `documents`         | `document:read`                                                    |                                              |
| `/directory`                                  | `DirectoryRoute`          | `directory`         | `directory:read`                                                   | `?q=`, `?person=`, `?page=`                  |
| `/announcements`                              | `AnnouncementsRoute`      | `announcements`     | `announcement:read`                                                | `?id=` selects the detail                    |
| `/help`                                       | `HelpRoute`               | `help`              | `ticket:read`                                                      |                                              |
| `/approvals`                                  | `ApprovalsRoute`          | `approvals`         | `leave:decide` **or** `expense:decide` **or** `attendance:approve` | `?tab=pending\|history`, `?kind=`            |
| `/hr/attendance`                              | `AttendancePeriodsRoute`  | `hrAttendance`      | `attendance:submit`                                                |                                              |
| `/hr/attendance/:periodId`                    | `AttendanceRecordsRoute`  | `hrAttendance`      | `attendance:record`                                                | The capture grid                             |
| `/hr/employees`                               | `EmployeesRoute`          | `hrEmployees`       | `employee:read` (ORG)                                              |                                              |
| `/hr/employees/:employeeId`                   | `EmployeeDetailRoute`     | `hrEmployees`       | `employee:read` (ORG)                                              |                                              |
| `/hr/policies`                                | `PoliciesAdminRoute`      | `hrPolicies`        | `policy:administer`                                                |                                              |
| `/hr/policies/:policyId/versions/:versionId`  | `PolicyVersionRoute`      | `hrPolicies`        | `policy:administer`                                                | Draft editor + publish                       |
| `/hr/policies/versions/:versionId/compliance` | `PolicyComplianceRoute`   | `hrPolicies`        | `policy:administer`                                                |                                              |
| `/hr/announcements`                           | `AnnouncementsAdminRoute` | `hrAnnouncements`   | `announcement:administer`                                          |                                              |
| `/hr/documents`                               | `DocumentsAdminRoute`     | `hrDocuments`       | `document:issue`                                                   | Letter request queue + upload                |
| `/hr/tickets`                                 | `TicketQueueRoute`        | `hrTickets`         | `ticket:administer`                                                |                                              |
| `/accounts/payroll`                           | `PayrollCyclesRoute`      | `payrollCycles`     | `payroll-cycle:read`                                               |                                              |
| `/accounts/payroll/:cycleId`                  | `PayrollCycleRoute`       | `payrollCycles`     | `payroll-cycle:read`                                               | Step tracker hub                             |
| `/accounts/payroll/:cycleId/inputs`           | `PayrollInputsRoute`      | `payrollInputs`     | `payroll-input:upload`                                             |                                              |
| `/accounts/payroll/:cycleId/validation`       | `ValidationReportRoute`   | `payrollValidation` | `payroll-cycle:validate`                                           |                                              |
| `/accounts/payroll/:cycleId/register`         | `PayslipRegisterRoute`    | `payrollRegister`   | `payslip:read-any`                                                 |                                              |
| `/accounts/reimbursements`                    | `ReimbursementsRoute`     | `reimbursements`    | `expense:reimburse`                                                |                                              |
| `/audit`                                      | `AuditRoute`              | `audit`             | `audit:read`                                                       | HR + Accounts                                |
| `*`                                           | `NotFoundRoute`           | —                   | authenticated                                                      | `<EmptyState>`-styled 404 inside the shell   |

**Query-parameter discipline.** Selection state that the prototype held in component state
(`payslip`, `policy`, `ann`, `person`, `ptab`, `apprTab`, `efOpen`, `dirQ`) becomes a search
param, so every selection is linkable, back-button-correct, and reachable from a
notification deep link. Search params are parsed through a per-route Zod schema; an invalid
value falls back to the default rather than throwing.

**Route-level code splitting.** `lazy()` per route group: the employee bundle never contains
the HR or Accounts route code. Combined with §1.2's permission gate this means a user without
`payroll-cycle:read` does not download the payroll screens at all.

### 1.3 The auth boundary

Implemented in `lib/authSession.ts` + `lib/apiClient.ts` + `hooks/useAuth.ts`.

**Where the credentials live**

| Credential                      | Where                                                                                                                     | Never                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Access token (600 s, EdDSA JWT) | A module-scope `let` inside the `authSession` closure. Exposed only as `getAccessToken()` / `setAccessToken()`.           | `localStorage`, `sessionStorage`, IndexedDB, a cookie, React state, a query cache entry, a Redux-like store, a URL |
| Refresh token                   | `__Host-wd_rt` cookie, `HttpOnly` — **the SPA cannot read it and never tries**                                            | Any JS access                                                                                                      |
| CSRF nonce                      | `__Host-wd_csrf` cookie (readable), echoed as `X-WD-CSRF` on `/auth/refresh`, `/auth/logout`, `/auth/logout-all` **only** | Any other route                                                                                                    |
| Identity for display            | `GET /me`, cached by TanStack Query                                                                                       | Decoding the JWT. `apiClient` must not import a JWT library                                                        |

The token is deliberately not React state: state lands in React DevTools and in error-reporting
snapshots. Components that need "am I signed in" read `useAuth().status`, which is derived
from a boolean the closure publishes through a subscription, not from the token itself.

**Cold start sequence** (`AuthProvider` mount)

1. `POST /auth/refresh` with `credentials: 'include'` and the `X-WD-CSRF` header.
2. `200` → `setAccessToken(accessToken)`, schedule the silent refresh, `status='authenticated'`.
   Then fire `GET /me` and `GET /me/bootstrap` **in parallel**; the shell renders its skeleton
   until both resolve.
3. `401` (no cookie, expired family, revoked, reuse detected) → `status='anonymous'`,
   redirect to `/login?next=<encodeURIComponent(location.pathname+search)>`. No error toast:
   an expired session is normal, not a failure.
4. Network error / `503` → `status='error'`, render `<ErrorState variant="offline">` with a
   Retry button. **Do not** treat a network failure as a logout; that would discard an
   otherwise valid session.

**Silent refresh.** A timer scheduled at `expiresIn - 60 s` (i.e. ~540 s) calls
`POST /auth/refresh`. The timer is cleared on logout and rescheduled on every successful
refresh. The tab also refreshes on `visibilitychange → visible` when the token has less than
60 s left, because background tabs throttle timers.

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

**`hardLogout(reason)`** — `clearAccessToken()`, cancel the refresh timer,
`queryClient.cancelQueries()` then `queryClient.clear()` (the cache holds salary and PII;
it must not survive a session), `navigate('/login?reason=' + reason)`. `POST /auth/logout` is
sent best-effort first when the reason is a user-initiated sign-out; clearing the client alone
is never treated as logout (`API.md` §13.1).

**The 403 step-up pipeline.** `403` with `code === 'MFA_STEP_UP_REQUIRED'` rejects into
`useStepUp()`, which opens `<StepUpDialog>` (a `Modal`), calls `POST /auth/mfa/step-up`,
stores the fresh access token and replays the original request **once**. A cancelled dialog
rejects the original promise with a typed `StepUpCancelled` error that mutations translate
into a dismissible inline banner, not a toast. Screens needing step-up: bank/statutory change
requests, unmask, payroll approve/publish, any export, role grants.

**Other statuses**, handled centrally so no screen re-implements them:

| Status / code               | `apiClient` behaviour                 | Screen behaviour                                                                      |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| `403 AUTHZ_DENIED`          | reject                                | `<ErrorState variant="forbidden">`; the control is also hidden by `can()` next render |
| `404`                       | reject                                | `<ErrorState variant="notFound">` — never "0 results"                                 |
| `409 VERSION_CONFLICT`      | reject                                | Inline banner "This changed while you were reading it." + auto-refetch of the entity  |
| `409 GUARD_FAILED`          | reject, expose `details.guardKey`     | Inline banner with the server `message` (it names the blocking step)                  |
| `422 *`                     | reject, expose `details.fieldErrors`  | `setError()` per field + `FormCard errorBanner`                                       |
| `423 ACCOUNT_LOCKED`        | reject                                | Login screen only; shows `Retry-After`                                                |
| `428 PRECONDITION_REQUIRED` | reject                                | Bug guard: log, refetch, retry once with the fresh `ETag`                             |
| `429`                       | reject, read `Retry-After`            | Disable the submit control for that many seconds with a countdown                     |
| `5xx`                       | retry twice with backoff, then reject | `<ErrorState variant="server">` showing `requestId` as the support reference          |

**Every request** carries `X-Request-Id: crypto.randomUUID()`, `Accept: application/json`, and
`Origin` (by the browser). `credentials` is `'include'` **only** on the three cookie routes and
`'omit'` everywhere else, so an access-token route can never be authenticated by a cookie.
Unsafe methods on idempotent endpoints carry `Idempotency-Key` (§1.5).

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
    approvalRecords: (id: string) => ['attendance', 'approval-records', id] as const,
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
  },
  audit: {
    list: (p: object) => ['audit', 'list', p] as const,
    chain: () => ['audit', 'chain'] as const,
  },
} as const;
```

Prefix invalidation is the norm: `invalidateQueries({queryKey: ['leave']})` covers balances,
requests and holidays in one call.

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

| Tier                  | `staleTime`                                                                                                                                 | `refetchOnWindowFocus` | Members                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Reference**         | `30 * 60_000`                                                                                                                               | `false`                | `leave.types`, `expenses.categories`, `documents.templates`, `help.categories`, `help.faq`, `leave.holidays` |
| **Identity / shell**  | `5 * 60_000`                                                                                                                                | `false`                | `me`, `bootstrap`                                                                                            |
| **Own records**       | `30_000`                                                                                                                                    | `'always'`             | payslips, tax, policies, leave requests, expenses, documents, benefits, profile                              |
| **Others' work**      | `15_000`                                                                                                                                    | `'always'`             | `approvals.*`, `attendance.approvals`, `hr.tickets`, `hr.documentRequests`                                   |
| **Counters**          | `60_000` + `refetchInterval: 60_000` (paused when the tab is hidden)                                                                        | `'always'`             | `notifications.unread`                                                                                       |
| **In-flight process** | `0` + `refetchInterval: 5_000` while `status ∈ {VALIDATING, CALCULATING}` or `run.status === 'RUNNING'`; interval returns `false` otherwise | `'always'`             | `payroll.cycle`, `payroll.run`                                                                               |
| **Search**            | `10_000`, `enabled: q.length >= 2`, 250 ms debounce, `placeholderData: keepPreviousData`                                                    | `false`                | `search`, `directory.people`                                                                                 |

`notifications.unread` is the only polled employee-facing query; everything else refreshes on
focus. There is no websocket in v1.

#### 1.4.4 The invalidation map (`lib/invalidation.ts`)

Every mutation declares its effect. A mutation that returns the canonical entity writes it with
`setQueryData` **and** invalidates the sibling lists — the write is a cache prime, never a
substitute for the server's list re-read (counts and rollups are server-computed).

| Mutation                                                   | `setQueryData`                                                                                     | Invalidate                                                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `POST /me/leave-requests`                                  | `qk.leave.requests` first page prepend via invalidate (no manual splice)                           | `['leave']`, `qk.home()`, `qk.bootstrap()`, `qk.notifications.unread()`                                                |
| `POST /me/leave-requests/:id/withdraw`                     | `qk.leave.requests` entry                                                                          | `['leave']`, `qk.home()`, `qk.bootstrap()`                                                                             |
| `POST /me/expense-claims`                                  | `qk.expenses.claim(id)`                                                                            | `['expenses']`, `qk.home()`                                                                                            |
| `POST /me/expense-claims/:id/withdraw`                     | `qk.expenses.claim(id)`                                                                            | `['expenses']`                                                                                                         |
| `POST /me/policies/:versionId/acknowledge`                 | `qk.policies.detail(versionId)`                                                                    | `qk.policies.list`, `qk.home()`, `qk.bootstrap()` (the `policiesPending` badge)                                        |
| `POST /me/tickets`                                         | `qk.help.ticket(id)`                                                                               | `qk.help.tickets`, `qk.home()`                                                                                         |
| `POST /me/tickets/:id/comments` · `/close` · `/reopen`     | `qk.help.ticket(id)`                                                                               | `qk.help.tickets`                                                                                                      |
| `POST /me/document-requests`                               | —                                                                                                  | `qk.documents.requests`, `qk.home()`                                                                                   |
| `POST /me/profile/change-request`                          | —                                                                                                  | `qk.help.tickets`, `qk.profile.tab(tab)`                                                                               |
| `POST /me/emergency-contacts` · `PATCH` · `DELETE`         | —                                                                                                  | `qk.profile.emergencyContacts()`, `qk.profile.tab('emergency')`                                                        |
| `PUT /me/tax/declaration` · `/submit` · `/proofs`          | `qk.tax.declaration()`                                                                             | `qk.tax.summary()`, `qk.tax.quarters()`                                                                                |
| `POST /me/dependents` · `PATCH` · `DELETE`                 | —                                                                                                  | `['benefits']`                                                                                                         |
| `POST /me/benefits/:planYearId/enrol`                      | —                                                                                                  | `['benefits']`, `qk.home()`                                                                                            |
| `POST /me/payslips/:id/email`                              | —                                                                                                  | none (fire-and-forget; toast from the response)                                                                        |
| `POST /me/announcements/:id/read`                          | `qk.announcements.detail(id)` → `isRead: true` (optimistic, rollback on error)                     | `qk.announcements.list` (silent)                                                                                       |
| `POST /me/notifications/read`                              | `qk.notifications.unread()` from the response's `unreadCount`                                      | `qk.notifications.list`, `qk.bootstrap()`                                                                              |
| `POST /manager/approvals/:id/decide`                       | `qk.approvals.pending` (remove the row), `qk.bootstrap()` badge from the response's `pendingCount` | `['approvals']`, `['leave']`, `['expenses']`, `['attendance']`, `qk.home()`                                            |
| `PUT /hr/attendance/periods/:id/records/:employeeId`       | that row in `qk.attendance.records`                                                                | `qk.attendance.period(id)` (control totals)                                                                            |
| `POST /hr/attendance/periods/:id/records:bulk`             | —                                                                                                  | `['attendance']`                                                                                                       |
| `POST /hr/attendance/periods/:id/submit`                   | `qk.attendance.period(id)`                                                                         | `['attendance']`, `['payroll']`, `qk.bootstrap()`                                                                      |
| `POST /manager/attendance/approvals/:id/decide`            | —                                                                                                  | `['attendance']`, `['approvals']`, `['payroll']`, `qk.bootstrap()`                                                     |
| `POST /payroll/cycles/:id/*` (every transition)            | `qk.payroll.cycle(id)` from the response                                                           | `['payroll']`, `['attendance']`, `qk.bootstrap()`                                                                      |
| `POST /payroll/cycles/:id/publish`                         | `qk.payroll.cycle(id)`                                                                             | `['payroll']`, and **nothing employee-side** — the publisher is not the employee; employees see it on their next fetch |
| `POST /hr/policies/versions/:id/publish`                   | —                                                                                                  | `['hr','policies']`, `['policies']`                                                                                    |
| `POST /hr/announcements/:id/publish` · `/pin` · `/archive` | —                                                                                                  | `['hr','announcements']`, `['announcements']`                                                                          |
| `POST /hr/tickets/:id/*`                                   | `qk.hr.tickets` row                                                                                | `['hr','tickets']`                                                                                                     |
| `POST /hr/document-requests/:id/issue` · `/reject`         | —                                                                                                  | `['hr','documentRequests']`                                                                                            |

**Optimism policy.** Optimistic updates are permitted for exactly two things: marking a
notification read, and marking an announcement read. Everything involving money, balances,
approvals, acknowledgements or workflow state waits for the server, because the server's number
is the only true one and a rolled-back optimistic balance is worse than a 400 ms wait.

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
2. `Idempotency-Key` from `useIdempotencyKey()` — one UUID per form instance, regenerated on
   success so a second deliberate submission is a new operation and a retry after a network
   blip is a replay.
3. `If-Match: version` when the DTO carried one.
4. On `422`: `err.details.fieldErrors` → `setError(path, {type:'server', message})`; any
   field error without a matching form path, plus every `409`/`403`, goes to the `FormCard`
   `errorBanner`. This banner **is** the prototype's `lfErr` / `efErr` / `tfErr` slot, same
   position, same `--tone-red-fg` colour, now `role="alert"`.
5. On success: `form.reset()`, close the disclosure if the form was one (`efOpen`), and raise a
   toast built **only** from response fields —
   `` `${res.ticket.ticketNo} raised · first response within ${res.slaHours} hours` ``. A toast
   never contains a value the client invented.

**Server-authoritative fields are never inputs.** The leave form does not post `totalDays`
(the prototype computed it in the browser); the expense form does not post a total; the ticket
form does not post an id. Where the prototype showed a client-derived figure, §6 names the
response field that replaces it.

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

```ts
export const SCREEN_PATHS = {
  home: () => '/',
  payslips: (p?: { id?: string }) => (p?.id ? `/payslips?id=${p.id}` : '/payslips'),
  tax: () => '/tax',
  profile: (p?: { tab?: ProfileTab }) => (p?.tab ? `/profile?tab=${p.tab}` : '/profile'),
  policies: (p?: { versionId?: string }) =>
    p?.versionId ? `/policies?versionId=${p.versionId}` : '/policies',
  leave: () => '/leave',
  benefits: () => '/benefits',
  expenses: (p?: { id?: string }) => (p?.id ? `/expenses?id=${p.id}` : '/expenses'),
  documents: () => '/documents',
  directory: (p?: { person?: string }) =>
    p?.person ? `/directory?person=${p.person}` : '/directory',
  announcements: (p?: { id?: string }) => (p?.id ? `/announcements?id=${p.id}` : '/announcements'),
  help: (p?: { ticketId?: string }) => (p?.ticketId ? `/help?ticketId=${p.ticketId}` : '/help'),
  approvals: (p?: { tab?: 'pending' | 'history' }) => `/approvals${p?.tab ? `?tab=${p.tab}` : ''}`,
  hrAttendance: (p?: { periodId?: string }) =>
    p?.periodId ? `/hr/attendance/${p.periodId}` : '/hr/attendance',
  payrollCycles: (p?: { cycleId?: string }) =>
    p?.cycleId ? `/accounts/payroll/${p.cycleId}` : '/accounts/payroll',
  /* …one entry per row of §1.2… */
} as const;
```

`toPath` validates the incoming `screen` against this map and returns `'/'` for an unknown
value (forward compatibility: a newer API may emit a screen this build does not have).
`deepLink.params` are whitelisted per screen and URL-encoded; **a deep link never becomes an
`href` without passing through this function**, so a malicious `deepLink` cannot produce a
`javascript:` URL.

`useDocumentTitle` sets `document.title = ${screenTitle} · ${organization.portalName}` where
`screenTitle` comes from the nav manifest (`bootstrap.nav`), which is also what the compact
`MobileHeader` renders — the prototype's `TITLES[screen]`, now server-supplied.

---

## 2. Design system implementation

### 2.1 The constraint, restated

`SECURITY.md` §6.3 ships `style-src 'self'; style-src-attr 'none'` with no nonce, because the
SPA is static on Netlify and a per-request nonce would need an edge function. Therefore the
prototype's 539 inline `style` attributes must become zero. The translation is mechanical:

| Prototype                                                                             | Production                                                                                                                                      |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `style="background:#172236;border:1px solid #263247;border-radius:12px;padding:20px"` | `className={styles.card}` in `Card.module.css` reading `var(--surface-raised)`, `var(--border)`, `var(--radius-lg)`, `var(--space-10)`          |
| `style="background:{{ n.bg }};color:{{ n.color }}"` (nav item, 2 states)              | `<NavItem data-active={active}>` + `[data-active='true']` selector                                                                              |
| `style="background:{{ s.bg }};color:{{ s.fg }}"` (chip, 5 tones)                      | `<StatusChip data-tone="green">` + `[data-tone='green']` selector                                                                               |
| `style="background:{{ m.color }}"` (avatar, 6 departments + fallback)                 | `<Avatar data-dept="platform-engineering">` + `[data-dept]` selectors; unknown department omits the attribute and inherits `--surface-selected` |
| `style="grid-template-columns:{{ splitCols }}"`                                       | `className={styles.splitGrid}` reading `var(--grid-split-current)`, flipped by `[data-stack='true']` on the shell                               |
| `style="width:{{ b.pct }}"` (progress bar, 0–100)                                     | `<ProgressBar data-pct={0..100}>` + the generated stylesheet of §2.3                                                                            |
| `style="bottom:{{ toastBottom }}"`                                                    | `var(--toast-bottom)`, redefined under `[data-compact='true']`                                                                                  |
| `style="transform:rotate({{ f.rot }})"` (accordion chevron)                           | `[aria-expanded='true'] .chevron { transform: rotate(180deg) }`                                                                                 |
| `style="animation:fade .15s ease"`                                                    | `.popover { animation: fade var(--duration-fast) var(--ease) }` in the module                                                                   |

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
2. `styles/generated/dept-accents.css` — `[data-dept='platform-engineering'] { --avatar-bg: var(--dept-platform-engineering) }`
   … generated from `@widedrop/shared` `DEPARTMENT_ACCENTS`, so adding a department is a shared-package
   change, not a CSS edit. The slug is `department.name` kebab-cased by a shared helper; an
   unrecognised slug simply has no rule and inherits `--dept-fallback`.

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
type MetricDto = {
  key: string;
  label: string;
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

interface MetricTileProps {
  metric: MetricDto;
  format: 'money' | 'days' | 'count' | 'percent';
  size?: 'md' | 'lg'; // 20px | 28px
}
```

`MetricTile` renders `metric.label` as the eyebrow, the formatted value (or `—` in
`--text-muted` with `aria-label="Not available"`) and `metric.subLabel` beneath. It never
receives a raw number: a caller with no `MetricDto` is a caller inventing data.

```ts
interface StatusChipProps {
  chip: ChipDto; // label + tone come from the server
  size?: 'sm' | 'md'; // 11.5px | 12px
  minWidth?: boolean; // the expenses list aligns chips at 96px
}
```

Renders `<span data-tone={chip.tone.toLowerCase()}>` with the label as text. Because the label
is always present, the chip never relies on colour alone (§7.6). An unknown `tone` string falls
back to `gray`.

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
the prototype's `sc-raw-select`. Options always come from an API list; a hardcoded `<option>`
set is a §6 defect. `disabled` options carry the persisted reason in their label
(e.g. "Comp-off — no balance").

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
  initials: string; // employee.initials — never computed client-side
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

| Element              | Wide (`≥880px` shell)                                        | Compact (`<880px` shell)                                                                      |
| -------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Primary nav          | `Sidebar`, 248px (72px when collapsed), grouped, with badges | `MobileHeader` (logo · screen title · notifications · avatar) + `TabBar`                      |
| `TabBar` items       | —                                                            | Home, Payslips, Leave, then **Approvals if the user can approve, else My profile**, then More |
| Full nav             | Always visible                                               | `MoreSheet` — a bottom sheet, 3-column grid of every permitted nav item                       |
| Global search        | In the top bar                                               | Not in the header; reachable from the More sheet as a full-width search row                   |
| Content padding      | `28px 32px 40px`                                             | `20px 16px 32px`                                                                              |
| Toast                | `bottom: 28px`                                               | `bottom: 86px` (clears the 62px tab bar plus its safe-area inset)                             |
| Notification popover | Anchored under the bell, 360px                               | Full width minus 32px, same anchor                                                            |
| Tables               | Real table rows                                              | Stacked definition rows (§2.6 `DataTable`)                                                    |

`TabBar` adds `padding-bottom: env(safe-area-inset-bottom)` and the toast offset adds it too, so
neither is obscured on an iPhone. The prototype's `framePad` / `shellMax` / `shellRadius` /
`shellBorder` device-frame props are a design-tool artefact and are **not** implemented: the
production shell is `100%` width and `100dvh` tall (`dvh`, not `vh`, so the mobile URL bar does
not clip the tab bar).

---

## 4. Empty states

Directive 9: every surface stays polished and truthful with zero data.

**Rules**

1. When the response carries an `emptyState` object, its `title` and `message` are rendered
   verbatim. They are resolved server-side from `ui_copy` with persisted `params` interpolated —
   the SPA must not "improve" them.
2. The **Local fallback** column below is used only when the endpoint sends no `emptyState`
   (`API.md` §1.6 rule 3: emptiness with no explanation beyond "there is nothing"). This copy is
   the one place the SPA owns words, and it contains no numbers, dates or names.
3. A metric tile with `value: null` renders `—` in `--text-muted` plus `subLabel`. If `subLabel`
   is also null, the fallback sub-label in the table is used.
4. A card whose entire content is unavailable still renders its `SectionHeader`, so the page
   composition is unchanged and the user can see the feature exists.
5. Where an action would help, the empty state offers exactly one `secondary` button, and only
   when the user holds the permission for it.

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

| Surface                     | Server code                          | Local fallback                                                                                                                                                                   |
| --------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attendance periods          | `ATTENDANCE_NO_PERIODS`              | "No attendance periods" / "A period appears here for each payroll cycle Accounts opens." / —                                                                                     |
| Attendance records grid     | — (`data: []`)                       | "No records captured" / "Upload a file or add records to begin." / "Upload records"                                                                                              |
| Submit blocked              | `canSubmit: false`                   | The Submit button is disabled and the `submitBlockers[]` messages are rendered as a list above it, verbatim (e.g. "Accounts has not locked payroll inputs for August 2026 yet.") |
| Employees                   | `EMPLOYEES_NONE`                     | "No employees match" / "Adjust the filters, or add an employee." / "Add employee"                                                                                                |
| Policies admin              | —                                    | "No policies yet" / "Create a policy and publish its first version." / "New policy"                                                                                              |
| Policy compliance           | `data: []`                           | "No assignments" / "Assignments appear when this version is published." / —                                                                                                      |
| Announcements admin         | —                                    | "No announcements" / "Draft an announcement and publish it to an audience." / "New announcement"                                                                                 |
| Letter request queue        | —                                    | "Nothing in the queue" / "Letter requests from employees appear here." / —                                                                                                       |
| Ticket queue                | —                                    | "Queue is clear" / "New help-desk tickets appear here." / —                                                                                                                      |
| Ticket email failure banner | `notificationEmailStatus = 'FAILED'` | Banner: "The email notification to {organization.helpdeskEmail} could not be delivered — this ticket is still open and assigned." with a Retry action for `org:manage` holders   |

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
  { id: 'home', label: 'Home', group: 'Overview', icon: 'home', permission: 'profile:read' },
  {
    id: 'payslips',
    label: 'Payslips',
    group: 'Pay & tax',
    icon: 'payslips',
    permission: 'payslip:read',
  },
  { id: 'tax', label: 'Tax slips', group: 'Pay & tax', icon: 'tax', permission: 'tax:read' },
  {
    id: 'profile',
    label: 'My profile',
    group: 'My workplace',
    icon: 'profile',
    permission: 'profile:read',
  },
  { id: 'leave', label: 'Leave', group: 'My workplace', icon: 'leave', permission: 'leave:read' },
  {
    id: 'benefits',
    label: 'Benefits',
    group: 'My workplace',
    icon: 'benefits',
    permission: 'benefit:read',
  },
  {
    id: 'expenses',
    label: 'Expenses',
    group: 'My workplace',
    icon: 'expenses',
    permission: 'expense:read',
  },
  {
    id: 'documents',
    label: 'Documents',
    group: 'My workplace',
    icon: 'documents',
    permission: 'document:read',
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
  { id: 'help', label: 'Help desk', group: 'Support', icon: 'help', permission: 'ticket:read' },
  {
    id: 'approvals',
    label: 'Approvals',
    group: 'Manager',
    icon: 'approvals',
    permission: 'leave:decide|expense:decide|attendance:approve',
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
    permission: 'employee:write',
  },
  {
    id: 'hrPolicies',
    label: 'Policy admin',
    group: 'People Ops',
    icon: 'policies',
    permission: 'policy:administer',
  },
  {
    id: 'hrAnnouncements',
    label: 'Announcement admin',
    group: 'People Ops',
    icon: 'announcements',
    permission: 'announcement:administer',
  },
  {
    id: 'hrDocuments',
    label: 'Letters & records',
    group: 'People Ops',
    icon: 'documents',
    permission: 'document:issue',
  },
  {
    id: 'hrTickets',
    label: 'Ticket queue',
    group: 'People Ops',
    icon: 'inbox',
    permission: 'ticket:administer',
  },
  {
    id: 'payrollCycles',
    label: 'Payroll cycles',
    group: 'Payroll',
    icon: 'payroll',
    permission: 'payroll-cycle:read',
  },
  {
    id: 'payrollInputs',
    label: 'Payroll inputs',
    group: 'Payroll',
    icon: 'upload',
    permission: 'payroll-input:upload',
  },
  {
    id: 'payrollValidation',
    label: 'Validation',
    group: 'Payroll',
    icon: 'alert',
    permission: 'payroll-cycle:validate',
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
               Letters & records · Ticket queue
Payroll        Payroll cycles            (read-only: HR holds payroll-cycle:read so it can see
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

The rule is a pure function of the manifest, `tabPriority(navItems)`, unit-tested per persona.
Everything not in the four slots is in the More sheet, which always lists the complete permitted
manifest grouped as in §5.2.

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

| Element                          | Source                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------- |
| Logo                             | `GET /me` → `organization.logoUrl`; `null` ⇒ the bundled `/widedrop-logo.png`   |
| "Widedrop" / "Employee portal"   | `organization.displayName` / `organization.portalName`                          |
| Nav groups, labels, order, icons | `GET /me/bootstrap` → `nav.groups` (+ `NAV_MANIFEST` icon per id)               |
| Approvals badge                  | `bootstrap.badges.approvals`; `0` ⇒ no element                                  |
| Notification dot                 | `GET /me/notifications/unread-count` → `hasUnread`                              |
| Sidebar user card                | `me.employee.initials`, `.fullName`, `` `${employeeNumber} · ${location}` ``    |
| Header user button               | `me.employee.fullName`, `.title`                                                |
| Header date                      | `bootstrap.todayLabel`                                                          |
| Search results                   | `GET /search?q=` → `data[]` (`kind`, `label`, `sub`, `deepLink`)                |
| Notification rows                | `GET /me/notifications` → `title`, `metaLabel`, `tone` (dot colour), `deepLink` |

**Interactions**

- Nav item / tab / More-sheet item → `navigate(SCREEN_PATHS[id]())`, close overlays, scroll
  `<main>` to top on the next frame (the prototype's `requestAnimationFrame` reset).
- Search input → 250 ms debounce → `qk.search(q)`; Enter activates the first result; Escape
  clears. Selecting a result → `toPath(deepLink)`.
- Notification row → `POST /me/notifications/read {ids:[id]}` then `toPath(deepLink)`.
- "Mark all read" → `POST /me/notifications/read {all:true}`; the badge is re-read from the
  response's `unreadCount`, not decremented locally.
- Avatar / user button → `/profile`.

**Loading** `AppShell.Skeleton`: sidebar rails with 6 shimmer rows, a header bar, and a
content-area `Skeleton variant="screen"`. **Error** `ErrorState variant="server" fullPage` with
Retry and Sign out. **Empty** — the shell has no empty state; a user with no permissions beyond
`profile:read` still gets Overview.

**Permission gate** `<RequireAuth>` on the layout route. Nav filtering is server-side.

**Prototype hardcodes replaced** — `"Widedrop"`/`"Employee portal"` → `organization.*`;
`"PR"` → `employee.initials`; `"Priya Raghavan"` → `employee.fullName`;
`"WDT-01847 · Bengaluru"` → `employeeNumber` + `location`; `"Senior Software Engineer"` →
`employee.title`; `"Tue, 29 Sep 2026"` → `bootstrap.todayLabel`; the always-on notification dot
→ `hasUnread`; the hardcoded `notifs` array → `GET /me/notifications`; the client-side `results`
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

All four blocks come from one call, `GET /me/home`, each block independently nullable.

**Fields**

| Element                                      | Source                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Greeting                                     | `greetingKey` → the label from `bootstrap`/`ui_copy`; name = `me.employee.preferredName` |
| Sub-header                                   | `home.subHeader` (composed server-side from date + location + site)                      |
| Latest payslip: month, amount, credited date | `latestPayslip.periodLabel`, `.netPay` (via `formatInr`), `.payDate`                     |
| Download PDF enabled                         | `latestPayslip.pdfAvailable`                                                             |
| Leave balance rows                           | `leaveBalancesTop3[]`: `leaveTypeName`, `availableDays`, `entitlementDays`, `percent`    |
| Approvals count + label                      | `approvals.pendingCount`; label singular/plural from the count                           |
| Approvals preview rows                       | `approvals.preview[]` → `subject.initials`, `subject.fullName`, `title`                  |
| Announcements rows                           | `announcements[]`: `title`, `categoryLabel`, `publishedAt`                               |
| Holidays rows                                | `holidays[]`: `date` → day/month/weekday formatted client-side from **one** date; `name` |
| Holiday card meta                            | `holidayCalendarName`                                                                    |
| Team rows                                    | `team[]`: `person.*`, `todayStatus` (`ChipDto`)                                          |
| To-dos                                       | `todos[]`: `title`, `subtitle`, `actionLabel`, `tone` (dot), `deepLink`                  |
| "N open"                                     | `todos.length`                                                                           |

**Interactions** "Apply leave" → `/leave`; "Raise ticket" → `/help`; "Download PDF" →
`download(GET /me/payslips/:id/download)`; "View details" → `/payslips?id=`; "Apply" →
`/leave`; "Review all" → `/approvals`; "View all" → `/announcements`; "Directory" →
`/directory`; an announcement row → `/announcements?id=`; a to-do row → `toPath(deepLink)`.
Home issues **no** mutations.

**Loading** Each card renders its own skeleton (metric shimmer, three bar rows, three list
rows) so the page composition is stable. **Empty** §4.2. **Error** Per-card `ErrorState` —
a failed `GET /me/home` renders one `ErrorState` in the content area, the shell intact.

**Permission gate** `profile:read`. The Approvals and Team cards are absent from the payload
for non-managers; the SPA additionally guards with `can('leave:decide') || can('expense:decide')`
so a stale payload cannot render a manager card.

**Prototype hardcodes replaced** — `"Good morning, Priya"` → `greetingKey` + `preferredName`;
`"Tuesday, 29 September 2026 · Bengaluru · Ecospace Tower A"` → `subHeader`; `PAYSLIPS[0]` net
and `"credited 31 Aug 2026"` → `latestPayslip`; `BAL.slice(0,3)` and the `pct` widths →
`leaveBalancesTop3[].percent`; `pendingCount` from a client array → `approvals.pendingCount`;
`ANN.slice(0,3)` → `announcements`; the `HOL` constant → `holidays` + `holidayCalendarName`;
`PEOPLE.filter(rel==='report')` and the `TEAM_TONE` map → `team[].todayStatus` (a `ChipDto`,
derived server-side from approved leave days and the holiday calendar); the `todos` built from
`POLICIES.filter(!ack)` → `todos[]`; `downloadLatest`'s invented filename toast → the
`Content-Disposition` filename from the signed URL.

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

**Interactions** Row click → `?id=` (the detail query is `enabled: !!id`; with no `id` the first
row is selected on load). "Download PDF" **[P]** `payslip:read` → `GET /me/payslips/:id/download`
via `lib/download.ts`; `409 PDF_NOT_READY` disables the button with the server reason.
"Email me" **[I]** → `POST /me/payslips/:id/email` with an **empty body**; the toast reads
`` `Payslip sent to ${res.toAddressMasked}` `` from the response. There is no recipient input.

**Loading** Four tile skeletons + six list-row skeletons + a detail skeleton matching the
two-column grid. **Empty** §4.3 — and note the list and the detail render the _same_
`emptyState`, so the split does not look broken. **Error** `500 INTEGRITY_ASSERTION_FAILED`
renders `ErrorState variant="server"` with the message "This payslip could not be verified.
Payroll has been notified." and no numbers at all.

**Permission gate** route `payslip:read`; download `payslip:read`.

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

**Interactions** "Update declaration" **[P]** `tax:declare` — enabled only when
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

**Permission gate** route `tax:read`; declaration edits `tax:declare`.

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

**Interactions** Tab change → `?tab=`, a separate query per tab (cached independently).
"Request a change" **[I][S for bank/statutory]** → a `Modal` with `section`, `fieldKey`,
`requestedValue`, `reason` (min 10) and a proof `FileField` where required →
`POST /me/profile/change-request`. The toast reads the persisted `ticket.ticketNo` and
`slaHours` from the response. Emergency tab: add/edit/delete contacts **[V]**.

**Loading** Header skeleton + 8 field-cell skeletons. **Empty** §4.5. **Error** Per-card.

**Permission gate** route `profile:read`; change requests `profile:request-change`; unmask is
server-gated and always step-up + audited.

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
meaningful if the whole policy was rendered. The acknowledge button is disabled until the body
region has been scrolled to its end **or** the body fits without scrolling (an
`IntersectionObserver` on a sentinel), with the disabled reason "Scroll to the end of the policy
to acknowledge."

**Interactions** Row click → `?versionId=`. **"I have read and acknowledge"** **[I]** →
`POST /me/policies/:versionId/acknowledge` with `bodySha256` (echoed from the detail response)
and `acknowledgementText` (echoed from `acknowledgementText`). On `201`/`200` the footer swaps
to "Acknowledged on {response.acknowledgedAt}" — **the persisted timestamp**, never `new Date()`.
On `422 BODY_HASH_MISMATCH` the screen refetches the detail and shows "This policy was updated
while you were reading it. Please read the new version." On `409 GUARD_FAILED` with
`details.currentVersionId`, it navigates to that version. Download **[P]** → signed URL; the
button is absent when `pdfAvailable` is false.

**Loading** Eight list-row skeletons + a detail skeleton. **Empty** §4.6. **Error** Per-pane.

**Permission gate** route `policy:read`; acknowledge `policy:acknowledge`.

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
startPortion, endPortion, reason}`. No `totalDays` is sent. The success toast is
`` `Leave request sent to ${res.approver.fullName}` `` — from the response's resolved approver,
not a hardcoded manager name. Inline 422s: `NO_WORKING_DAYS_IN_RANGE`, `LEAVE_DATES_OVERLAP`,
`INSUFFICIENT_LEAVE_BALANCE` (shows `details` balance), `MIN_NOTICE_NOT_MET`,
`ATTACHMENT_REQUIRED`, `MANAGER_NOT_RESOLVED` — each rendered in the `FormCard` error banner
with the server message. "Withdraw" **[I][V]** → `POST /me/leave-requests/:id/withdraw`; the
control renders only when `canWithdraw` is true.

**Loading** Five tile skeletons, a form skeleton, four request-row skeletons.
**Empty** §4.7. **Error** Per-card; a failed `GET /leave/types` disables the form with a reason
rather than rendering an empty dropdown.

**Permission gate** route `leave:read`; submit `leave:request`; withdraw `leave:withdraw`.

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

**Permission gate** route `benefit:read`; enrol/dependents `benefit:enrol`.

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
`purpose=EXPENSE_BILL`; the returned `fileId` goes into `attachmentFileIds`. Upload shows the
scan status; a file that is not `CLEAN` blocks submit with the server's reason. Submit **[I]** →
`POST /me/expense-claims` with `lines[]` (the single-line form posts one line) and **no total**.
The toast reads `res.claimNo`. Inline 422s: `EXPENSE_LIMIT_EXCEEDED` (shows the cap and basis),
`ATTACHMENT_REQUIRED`, `CLAIM_WINDOW_CLOSED`, `MANAGER_NOT_RESOLVED`.
"Withdraw" appears on a row only when `canWithdraw` **[I][V]**.

**Loading** Three tile skeletons + six row skeletons. **Empty** §4.9. **Error** Per-card.

**Permission gate** route `expense:read`; create `expense:submit`; withdraw `expense:withdraw`.

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

**Permission gate** route `document:read`; request `document:request`.

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

**Fields** `GET /directory/people?q=&page=` → `data[]` (`fullName`, `initials`,
`accentColourHex` → `deptSlug`, `title`, `department`, `location`, `workEmail`, `workPhone`)
and `page.total` (the header count). `GET /directory/people/:id` adds `reportsTo`.
`GET /me/reporting-line` → `ancestors[]`, `self`, `reports[]` with server-supplied
`relationLabel` strings.

**Interactions** Search → 250 ms debounce → `?q=` + `page=1`. Card click → `?person=`.
"Copy email" → `navigator.clipboard.writeText(person.workEmail)` inside try/catch; the toast is
`` `${workEmail} copied` `` and appears only on success (a clipboard failure shows the address
in a selectable inline field instead). `workPhone` is rendered only when the field is present —
it is omitted by the API unless the actor holds `directory:read_contact`.

**Loading** Twelve card skeletons. **Empty** §4.11. **Error** Per-region.

**Permission gate** route `directory:read`.

**Prototype hardcodes replaced** — the twelve-person `PEOPLE` array, the derived `email`
(`name.toLowerCase().replace(' ','.')+'@widedrop.com'`) and `initials` → the API's
`workEmail` and `initials` (generated columns); `DEPT_COLOR` → `accentColourHex` mapped to a
`data-dept` slug; `"12 people shown"` → `page.total`; the reporting line assembled from
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

**Permission gate** route `announcement:read`. Audience filtering is a server-side query
predicate — a non-targeted announcement is not in the response at all, not merely hidden.

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
(§4.15). Attachments via `POST /files` (`purpose=TICKET_ATTACHMENT`, max 3).
FAQ rows use `Accordion` with single-open semantics.

**Loading** Form skeleton + three ticket rows + four FAQ rows. **Empty** §4.13 — note the FAQ
card is **not rendered at all** with zero rows. **Error** Per-card.

**Permission gate** route `ticket:read`; create `ticket:create`; comment `ticket:comment`.

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

**Interactions** Approve / Reject **[I][V]** → `POST /manager/approvals/:id/decide`
`{outcome, note?}`. Reject opens a `Modal` requiring a note of at least 10 characters
(`approval.note_required`), because a rejection without a reason is not actionable for the
employee. The row is removed on success and the badge is set from the response's `pendingCount`
— never decremented locally. `409 STATE_TRANSITION_NOT_ALLOWED` (someone else decided, or the
employee withdrew) shows "This request was already decided" and refetches.
`403 SELF_APPROVAL_FORBIDDEN` shows the server message and refetches. Expense tasks additionally
allow a partial `approvedAmountMinor` in the modal, bounded by the claim total.
Attendance tasks link to `/hr/attendance/:periodId` — the manager's slice view (§6.15).

**Loading** Four card skeletons + an aside skeleton. **Empty** §4.14 — the "All caught up"
block is `EmptyState tone="positive"`, matching the prototype's green check.
**Error** Per-pane.

**Permission gate** route `leave:decide || expense:decide || attendance:approve`; each card's
buttons additionally check the kind-specific permission, so a manager who can approve leave but
not expenses sees the expense card read-only with the reason.

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

**Empty / Error** §4.15. **Permission gate** route `attendance:submit`; the capture link needs
`attendance:record`.

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
save is attempted. Bulk upload **[I]** → `POST /files` (`ATTENDANCE_UPLOAD`) →
`POST …/records:bulk`, whose row-level report renders as a rejection `DataTable`: valid rows
committed, rejected rows listed with `rowNo`, `employeeNumber`, `reason`, `message`. Nothing is
silently coerced, and the report is not dismissible until acknowledged.

**Permission gate** `attendance:record`. The same screen serves a **Manager** at
`/approvals` → attendance task → their slice, where every cell is read-only and the actions are
Approve / Return with a mandatory note (`POST /manager/attendance/approvals/:id/decide`).

### 6.16 HR · Employees, Policy admin, Announcement admin, Letters, Tickets

| Screen                                     | Layout                                                                   | Key endpoints                                                                                                                                                 | Notable rules                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Employees** `/hr/employees`              | Directory grid + filters (department, location, status, q); `Pagination` | `GET /hr/employees`, `POST /hr/employees` **[I]**, `PATCH /hr/employees/:id` **[V][S]**, `POST …/invite` **[I]**, `POST …/deactivate` **[I][S]**              | Bank and statutory sections are **not** on the HR screen (`SECURITY.md` §4.4: HR cannot see full bank numbers). Deactivate requires a reason and step-up                                                                                                                                                                                                     |
| **Employee detail** `/hr/employees/:id`    | My profile layout                                                        | `GET /hr/employees/:id`                                                                                                                                       | Masked values only; no unmask control for HR on bank/statutory                                                                                                                                                                                                                                                                                               |
| **Policy admin** `/hr/policies`            | Policies split; right pane = version list + draft editor                 | `GET/POST /hr/policies`, `POST /hr/policies/:id/versions` **[I]**, `PATCH …/versions/:id` **[V]** (DRAFT only), `POST …/publish` **[I]**                      | The editor writes `bodyMarkdown`, `points[]`, `applicabilityRules[]`, and one of `acknowledgementDueDays`/`acknowledgementDueOn`. Publish shows the real `assignmentsCreated` / `assignmentsSuperseded` / `notificationsQueued` from the transaction. `409 SEGREGATION_REQUIRED` renders "You authored this version — a second HR approver must publish it." |
| **Policy compliance**                      | Tile row (assigned / acknowledged / pending / overdue) + table           | `GET /hr/policies/versions/:id/compliance`                                                                                                                    | Summary is the server's `GROUP BY`; the client computes no percentages other than `round(ack/assigned*100)` for the bar, which is hidden when `assigned = 0`                                                                                                                                                                                                 |
| **Announcement admin** `/hr/announcements` | Announcements split; composer replaces the reader                        | `POST /hr/announcements`, `PATCH` **[V]** (DRAFT only), `POST …/publish` **[I]**, `/pin`, `/unpin`, `/archive`                                                | Audience builder writes `announcement_audience` rows; publish reports the real `notificationsQueued`. A future `publishAt` shows the persisted `SCHEDULED` state, not a client timer                                                                                                                                                                         |
| **Letters & records** `/hr/documents`      | Queue table (left, `formCols`) + issue form (right)                      | `GET /hr/document-requests`, `POST …/:id/issue` **[I][S when the template includes salary]**, `POST …/:id/reject`, `POST /hr/employees/:id/documents` **[I]** | Overdue rows are flagged from `dueAt`, which was computed against the holiday calendar server-side                                                                                                                                                                                                                                                           |
| **Ticket queue** `/hr/tickets`             | Help-desk list as a `DataTable` + a thread pane                          | `GET /hr/tickets`, `POST …/assign` **[I]**, `POST …/comments`, `POST …/resolve` **[I]**                                                                       | The thread shows `INTERNAL` comments to HR only — they are excluded by the employee query and by RLS, never hidden client-side. A `notificationEmailStatus = 'FAILED'` renders the §4.15 banner                                                                                                                                                              |

### 6.17 Accounts · Payroll cycles (`/accounts/payroll`, `/accounts/payroll/:cycleId`)

**Layout** `ListDetailSplit grid="split"`. Left: cycle rows (label, period, `StatusChip`).
Right, in order:

1. **Step tracker** — seven rows from `stepTracker[]`, each a check/current/blocked/pending
   glyph, the label, the owner, and `blockedReason` when blocked. This is the mandated workflow
   made visible: _Accounts uploads → HR submits attendance → Managers approve → system validates
   → payroll generated → second Accounts approver → published_.
2. **Control totals** — three `MetricTile`s (Gross / Deductions / Net), `—` until `CALCULATED`.
3. **Counts** — `employeeCount`, `payslipCount`, `attendancePeriod.status`.
4. **Actions** — one `Button` per entry in `availableTransitions[]`, labelled by the server,
   disabled when `guardsSatisfied` is false with `blockingReason` as the disabled reason.
   The client never decides which transition is legal.

**Interactions** Every action is `POST /payroll/cycles/:id/<verb>` **[I][V]**, with **[S]** on
`approve` and `publish`. `publish` additionally opens a confirmation `Modal` that restates
`publishedPayslipCount` **after** the call from the response, and the success toast reads
"{n} payslips published" from that number. `409 SEGREGATION_REQUIRED` renders the server's
`requires` text. While `status ∈ {VALIDATING, CALCULATING}` the cycle query polls every 5 s and
the actions are disabled with "Running…".

**Empty / Error** §4.16. **Permission gate** route `payroll-cycle:read`; each action's own
permission (`payroll-cycle:create|validate|generate|publish|cancel`, `payroll-input:upload`).
HR holds only `payroll-cycle:read`, so HR sees the tracker and **no** action buttons.

### 6.18 Accounts · Payroll inputs (`/accounts/payroll/:cycleId/inputs`)

**Layout** Header with the cycle label + `StatusChip`; an **Upload** `FormCard` (`FileField`
accepting CSV/XLSX, an optional declared control total, a note); a **Batches** `DataTable`
(batch no · filename · rows total/valid/rejected · declared vs parsed total · status · actions);
a **Rejections** table for the selected batch; and a **Lock inputs** panel.

**Interactions** `POST /files` (`PAYROLL_INPUT_UPLOAD`) → `POST …/input-batches` **[I]**. The
response's `rejections[]` and `parseErrors[]` render immediately, with `rowNo` and the exact
message — the traceability link back to the uploaded line. `commit` **[I][V]** requires
declared = parsed (`422 CONTROL_TOTAL_MISMATCH` renders both figures). `DELETE` marks the batch
`DISCARDED`, never a hard delete, and the UI says so. **Lock inputs** **[I][V]** →
`POST …/lock-inputs`; the success toast states that HR can now submit attendance, because that
is exactly what the transition does. Item amounts are visible only to `payroll-input:upload`
holders and every such read is a `READ_SENSITIVE` audit event — the screen shows a one-line
notice to that effect.

### 6.19 Accounts · Validation report (`/accounts/payroll/:cycleId/validation`)

**Layout** Header + a "Run validation" `Button primary` **[I][V]**; a severity summary row
(three `MetricTile`s: Errors / Warnings / Info, from the `summary` object); a filter row
(severity, unresolved only, pass no.); a results `DataTable` (rule code · severity chip ·
employee · message · resolved). Selecting a row opens a detail panel with `detail` and a
resolve form.

**Interactions** `POST /payroll/cycles/:id/validate` **[I][V]** — refused with
`409 GUARD_FAILED` while attendance is not `APPROVED`/`LOCKED`, and the screen renders that
message rather than a generic error, so the operator sees _which_ upstream step is incomplete.
Resolve **[P]** `payroll-cycle:validate` → `POST …/validation-results/:id/resolve` with a note
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

| Surface                       | Behaviour                                                                                                                                                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sidebar**                   | A single tab stop per nav group is wrong here — the prototype's items are buttons in a list, so each is tabbable, in DOM order, and `aria-current="page"` marks the active one. Groups are `<ul role="list">` with an `aria-labelledby` pointing at the group label                           |
| **TabBar**                    | Roving tabindex: one tab stop; Left/Right move, Home/End jump, Enter/Space activate                                                                                                                                                                                                           |
| **SegmentedTabs**             | `role="tablist"` + `role="tab"`/`aria-selected` + `role="tabpanel"` with `aria-labelledby`; Left/Right/Home/End with automatic activation (the panels are cheap)                                                                                                                              |
| **MoreSheet / Modal / Sheet** | Focus is trapped (`useFocusTrap`), `aria-modal="true"`, `role="dialog"`, `aria-labelledby` the title. Escape closes (except the non-dismissible step-up dialog). Focus returns to the invoking control. Background content gets `inert` where supported, `aria-hidden` otherwise              |
| **GlobalSearch**              | `role="combobox"` on the input with `aria-expanded`, `aria-controls`, `aria-autocomplete="list"`; the dropdown is `role="listbox"` with `role="option"` children and `aria-activedescendant`. Down/Up move, Enter selects, Escape closes and restores the query, Tab closes without selecting |
| **NotificationPopover**       | `role="dialog"` anchored to the bell, focus moved to the heading on open, Escape closes, Tab cycles within, focus returns to the bell                                                                                                                                                         |
| **DataTable**                 | Native table semantics; when `onRowActivate` is set the first cell contains a real `<button>` so the row is reachable and announced — the whole row is never a click target without a focusable element                                                                                       |
| **Accordion**                 | Each question is a `<button aria-expanded aria-controls>`; the panel is a region labelled by it. Up/Down move between headers, Home/End jump                                                                                                                                                  |
| **ListDetailSplit**           | The list is `role="listbox"`-free: rows are buttons with `aria-current="true"` on the selected one, and the detail pane has `aria-live="polite"` on its heading so a selection change is announced                                                                                            |

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

| Pair                                             | Ratio    | Use                                                                                                                                                                                          |
| ------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--text` #F2F5FA on `--surface-shell` #0F1622    | ≈ 15.9:1 | Body                                                                                                                                                                                         |
| `--text` on `--surface-raised` #172236           | ≈ 14.2:1 | Card body                                                                                                                                                                                    |
| `--text-secondary` #A9B4C7 on `--surface-raised` | ≈ 7.7:1  | Secondary text                                                                                                                                                                               |
| `--text-muted` #7C8AA3 on `--surface-raised`     | ≈ 4.6:1  | Meta text — passes, and is therefore permitted at 12px                                                                                                                                       |
| `--text-dim` #5F6D86 on `--surface-raised`       | ≈ 2.9:1  | **Fails body contrast.** Permitted only for uppercase eyebrow labels ≥ 11px/500 that duplicate adjacent information, and for decorative glyphs. Never for a value, a status, or an only-copy |
| `--accent` #6EA8FF on `--surface-shell`          | ≈ 7.6:1  | Links, focus ring                                                                                                                                                                            |
| `--surface-on-accent` #0B1729 on `--accent`      | ≈ 9.2:1  | Primary button label                                                                                                                                                                         |
| `--tone-green-fg` on `--tone-green-bg`           | ≈ 7.4:1  | Chip                                                                                                                                                                                         |
| `--tone-amber-fg` on `--tone-amber-bg`           | ≈ 8.3:1  | Chip                                                                                                                                                                                         |
| `--tone-red-fg` on `--tone-red-bg`               | ≈ 6.6:1  | Chip                                                                                                                                                                                         |
| `--tone-blue-fg` on `--tone-blue-bg`             | ≈ 5.6:1  | Chip                                                                                                                                                                                         |
| `--tone-gray-fg` on `--tone-gray-bg`             | ≈ 7.0:1  | Chip                                                                                                                                                                                         |
| `--text-invert` on `--surface-selected` #1B365D  | ≈ 12.3:1 | Selected nav item                                                                                                                                                                            |
| `--border` #263247 on `--surface-raised`         | ≈ 1.3:1  | Decorative divider only — never the sole indicator of a control's boundary; every input also has a distinct background (`--surface-panel`) against its container                             |

A Vitest contract test recomputes every pair from `@widedrop/shared` tokens and fails if a ratio
drops below its documented floor, so a future token tweak cannot silently break contrast. The
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
- The refresh token is `HttpOnly`; no code reads `document.cookie` except the CSRF helper, which
  reads only `__Host-wd_csrf`.
- A full page reload deliberately loses the access token and re-derives it from the cookie. This
  is the point: an XSS payload that runs after load finds nothing durable to steal, and the
  refresh cookie it cannot read.
- `queryClient.clear()` on logout, on `SESSION_REVOKED`, and on `visibilitychange` after 12 h of
  background time, so payslip and profile data do not linger in memory indefinitely.
- No "remember me", no persisted query cache, no service worker caching API responses. The
  service worker, if added later, must exclude `/api/v1/**` by origin.

### 8.2 Nothing secret in the bundle

- Configuration reaches the app through build-time `import.meta.env.VITE_*` (API origin, app
  version, Sentry DSN) — public values only. There is **no** inline
  `<script>window.__ENV=…</script>`; that would need `script-src 'unsafe-inline'`.
- `.env` files are not committed; `VITE_` variables are set in the Netlify build environment.
  A CI grep fails the build if a bundle contains a string matching the API-key or private-key
  patterns, or the literal `widedrop` service credentials names.
- Source maps are uploaded to the error tracker and **not** served publicly
  (`build.sourcemap: 'hidden'`).
- The bundle contains no seeded operational data: no employee list, no salary figure, no policy
  text. A CI grep asserts the prototype's fixture identifiers (`WDT-01847`, `EXP-2291`,
  `HD-4821`, `Priya Raghavan`) appear nowhere in `dist/`.

### 8.3 The CSP the app must satisfy

Served by Netlify for `ess.widedrop.com` (`SECURITY.md` §6.3), enforced, not report-only, after
one release in report-only:

```
default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'none';
style-src-elem 'self'; img-src 'self' blob:; font-src 'self';
connect-src 'self' https://api-ess.widedrop.com; manifest-src 'self'; worker-src 'self';
form-action 'none'; frame-ancestors 'none'; frame-src 'none'; base-uri 'none';
object-src 'none'; media-src 'none'; upgrade-insecure-requests;
require-trusted-types-for 'script'; trusted-types default;
report-uri https://api-ess.widedrop.com/csp-report; report-to csp
```

What the frontend must do to live inside it:

| Directive                            | Frontend obligation                                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `style-src-attr 'none'`              | Zero `style` attributes (§2.1), verified in CI                                                                                                                                                                     |
| `style-src 'self'`                   | CSS Modules only; no runtime `<style>` injection; no CSS-in-JS                                                                                                                                                     |
| `script-src 'self'`                  | No inline script, no `eval`, no `new Function`. Vite: `build.modulePreload.polyfill = false`, no `@vitejs/plugin-legacy`                                                                                           |
| `font-src 'self'`                    | IBM Plex is self-hosted in `public/fonts` (already present). **No Google Fonts link at runtime**                                                                                                                   |
| `img-src 'self' blob:`               | Logos and avatars are same-origin or initials; `blob:` exists only for previewing a just-selected upload. No external image host, no gravatar                                                                      |
| `connect-src`                        | Exactly one API origin. Any analytics or error endpoint must be added here explicitly and justified                                                                                                                |
| `form-action 'none'`                 | Every submission is `fetch`; no `<form action>` navigation                                                                                                                                                         |
| `frame-ancestors 'none'`             | Plus `X-Frame-Options: DENY` for old clients                                                                                                                                                                       |
| `base-uri 'none'`                    | No `<base>` tag; relative URLs resolve against the document only                                                                                                                                                   |
| `require-trusted-types-for 'script'` | No `innerHTML`, no `outerHTML`, no `insertAdjacentHTML`, no `document.write`. If a Trusted Types policy is ever needed it is a single named policy in `lib/sanitize.ts`, not `default` with a permissive transform |

`apps/web/public/_headers` and `infra/netlify/netlify.toml` both carry the header, and a
Playwright test asserts the deployed header string matches the one in this document character
for character.

### 8.4 Server-supplied rich text

Two fields are author-controlled Markdown: `policy_version.body_markdown` and
`announcement.body_markdown` (plus `faq.answer_markdown`). The API deliberately never sends
HTML.

The rendering policy in `lib/sanitize.ts`:

1. Parse Markdown with `marked` configured `{ gfm: true, breaks: false }` and **no HTML
   passthrough** (`marked` option to escape raw HTML, so `<script>` in the source becomes text).
2. Render to a **React element tree**, not to an HTML string. `dangerouslySetInnerHTML` does not
   appear anywhere in the codebase; an ESLint rule bans it with no permitted disables. This makes
   the Trusted Types requirement trivially satisfied — there is no HTML sink.
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
7. Length is bounded: a body over 200 000 characters (the server's own cap) is truncated with a
   "Download the PDF to read the full policy" notice rather than freezing the tab.

`policy.bodySha256` is echoed back on acknowledge, so an acknowledgement provably refers to the
bytes the client rendered — and a mid-read republish is caught as `BODY_HASH_MISMATCH` rather
than silently acknowledging the wrong text (§6.5).

### 8.5 File downloads

Every download goes through `lib/download.ts`:

1. `fetch(downloadUrl, {headers: auth})` → the API replies `302` to a short-lived signed URL, or
   `409` when the object is not ready.
2. The SPA follows the redirect **as a navigation of a hidden anchor**, not by reading the body
   into memory: `a.href = signedUrl; a.rel = 'noopener'; a.download = ''; a.click()`. The
   filename comes from the server's `Content-Disposition`; the client never invents one (the
   prototype's "Downloading Payslip_Aug-2026.pdf" toast is gone).
3. The signed URL is never logged, never put in the query cache, never added to browser history
   (`window.open` is not used; the anchor is removed immediately after the click).
4. `409 PDF_NOT_READY` / `ECARD_NOT_ISSUED` disables the control with the server's reason instead
   of failing silently.
5. Uploads: `FileField` checks the extension and size against `@widedrop/shared` `FILE_LIMITS`
   and `ACCEPTED_UPLOAD_TYPES` for immediate feedback, then posts multipart to
   `POST /api/v1/files`. **The client's check is convenience only** — the server sniffs the
   content type, scans the file, and can reject anything. A file whose `scanStatus` is not
   `CLEAN` cannot be attached, and the UI states that rather than queueing it.
6. Filenames rendered in the UI pass through `safeDisplayFilename()` from
   `@widedrop/shared`, which strips directory separators and control characters, so a hostile
   filename cannot spoof a path or inject bidi characters.

### 8.6 Other client-side controls

| Concern                 | Control                                                                                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Clickjacking**        | `frame-ancestors 'none'`; no framebusting script is needed or shipped                                                                                                                                                                           |
| **Open redirect**       | The `?next=` parameter on `/login` is accepted only when it starts with a single `/` and is not `//` or `/\`; otherwise the user lands on `/`                                                                                                   |
| **Deep-link injection** | `toPath()` whitelists the screen id and encodes params (§1.8); a `deepLink` never becomes an `href` unvalidated                                                                                                                                 |
| **Clipboard**           | `navigator.clipboard.writeText` is used only for a work email, inside try/catch, and never for a token or a masked value                                                                                                                        |
| **`postMessage`**       | Not used. No `window.opener` is ever created (`rel="noopener"` everywhere)                                                                                                                                                                      |
| **Third-party scripts** | None. No analytics, no tag manager, no chat widget. Adding one requires a `script-src`/`connect-src` change and a review recorded in `SECURITY.md`                                                                                              |
| **Dependency surface**  | Direct deps are the ten in `apps/web/package.json` plus `marked`. `npm audit --omit=dev` runs in CI; a high or critical finding fails the build. Lockfile is committed and `npm ci` is used                                                     |
| **Error reporting**     | If enabled, the client scrubs `Authorization`, `Cookie`, `X-WD-CSRF`, every request/response body, and any field whose key matches the shared redaction denylist, before sending. Only `requestId`, route, and the error code leave the browser |
| **Masked values**       | A masked string is display-only and is never submitted back as an input; `POST /me/profile/change-request` rejects a value matching the mask pattern, and the client pre-empts that with a field error                                          |
| **Autocomplete**        | `autoComplete="off"` on amount, date-of-spend and any field carrying another person's data; `autoComplete="current-password"`/`"one-time-code"` used correctly on the auth screens                                                              |
| **Session end**         | On `hardLogout` the cache is cleared and the URL is replaced (not pushed), so the back button cannot re-render a cached authenticated screen                                                                                                    |

---

## 9. Testing obligations for this spec

| Test                                                | Asserts                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `tokens.contract.test.ts`                           | Every token in `tokens.ts` exists in `tokens.css` and vice versa                  |
| `contrast.test.ts`                                  | Every pair in §7.7 meets its floor                                                |
| `no-inline-styles.spec.ts` (Playwright, all routes) | `[style]` count is 0                                                              |
| `csp.spec.ts`                                       | The served header equals §8.3 verbatim                                            |
| `useContainerBreakpoints.test.ts`                   | 880/820 thresholds, no redundant setState, `matchMedia` fallback                  |
| `nav.persona.test.ts`                               | The five nav trees of §5.2 and the tab-bar slots                                  |
| `emptyState.<screen>.test.tsx`                      | Each screen renders §4's copy with a zero-data fixture, and renders **no** number |
| `authSession.test.ts`                               | Single-flight refresh, one replay, `hardLogout` on second 401, cache cleared      |
| `sanitize.test.ts`                                  | The hostile-Markdown corpus produces no disallowed node or scheme                 |
| `invalidation.test.ts`                              | Every mutation in §1.4.4 invalidates exactly its listed keys                      |
| `a11y.<screen>.test.tsx`                            | `vitest-axe` clean, focus order, live-region announcements                        |
| `bundle.test.ts`                                    | No fixture identifier and no secret pattern in `dist/`                            |

---

## 10. Open risks

1. **Three permission vocabularies exist in the repository.** `packages/shared/src/rbac/roles.ts`
   uses `resource:action` (`policy:acknowledge`), `docs/SECURITY.md` §4.4 uses
   `verb:resource[:qualifier]` (`acknowledge:policy:self`), and `docs/API.md` §13 uses
   `resource:verb:qualifier` (`policy:acknowledge:self`). **This document uses the
   `packages/shared` spelling**, because that is the union the SPA actually imports and the one a
   compile error can protect. Before implementation one spelling must win and the other two
   documents must be updated; the mapping is otherwise one-to-one and mechanical.
2. **`GET /me/bootstrap`'s nav manifest must stay in step with `NAV_MANIFEST`.** The server
   filters and the client renders; if the server emits a screen id the client does not know, the
   item is dropped (the client must not crash). A shared-package contract test should assert both
   sides enumerate the same ids.
3. **"Compare regimes" is dropped** for want of a persisted source (§6.3). If the business wants
   it, it needs an `employee_tax_projection` row per regime and a new endpoint; it must not be
   computed in the browser.
4. **The Home screen depends on one endpoint.** `GET /me/home` failing takes the whole screen to
   an error state. If block-level resilience matters more than the single round trip, the
   endpoint should return per-block errors rather than failing whole — a server-side decision.
5. **Attendance grid scale.** A 5 000-employee period in one cursor-paginated grid with per-row
   `PUT` on blur will be slow for bulk edits. The bulk-upload path is the intended mechanism; if
   inline editing at that scale becomes the norm, a batched `PATCH` endpoint is needed.
6. **`--text-dim` fails body contrast** (2.9:1) and is used by the prototype for uppercase
   eyebrow labels. The allowlist in §7.7 keeps it legal, but an auditor may still flag it; the
   fallback is to promote eyebrow labels to `--text-muted` (4.6:1), which is a one-token change
   and does not alter the layout.
7. **Container queries would be cleaner than the `ResizeObserver`.** They are now broadly
   supported, but the prototype's behaviour is specified in JS and two thresholds observe two
   different elements, one of which is an ancestor of the other. The observer is kept for exact
   fidelity; migrating to `@container` later is a mechanical change confined to §3.
