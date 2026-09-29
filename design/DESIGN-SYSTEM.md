# Widedrop ESS — Design System (extracted from the prototype)

**Source of truth:** `design/prototype/Widedrop-Employee-Portal.bundled.html`
(decoded to `prototype-markup.html` + `prototype-logic.jsx` in the same folder).

The production UI MUST preserve this visual language, navigation model and
responsive behaviour. Values below were extracted verbatim from the prototype —
do not invent new hues, spacings or radii.

## 1. Colour tokens

### Surfaces (dark, `color-scheme: dark`)

| Token                  | Hex       | Use                                           |
| ---------------------- | --------- | --------------------------------------------- |
| `--bg-page`            | `#070B12` | Outermost page background                     |
| `--bg-shell`           | `#0F1622` | App shell / content background                |
| `--bg-panel`           | `#121B2B` | Sidebar, top bar, cards, popovers             |
| `--bg-raised`          | `#172236` | Inset rows, table headers, form fields, wells |
| `--bg-hover`           | `#1D2A42` | Row / list-item hover                         |
| `--bg-hover-nav`       | `#1A2538` | Sidebar nav item hover                        |
| `--bg-selected`        | `#1B365D` | Selected nav item, selected row, active tab   |
| `--bg-badge-on-accent` | `#0B1729` | Text colour on a `#6EA8FF` badge              |

### Borders

| Token             | Hex       | Use                                                |
| ----------------- | --------- | -------------------------------------------------- |
| `--border`        | `#263247` | Default border for cards, inputs, buttons          |
| `--border-subtle` | `#1F2A3D` | Structural dividers (sidebar edge, top bar bottom) |
| `--border-strong` | `#2F3D55` | Scrollbar thumb, emphasised dividers               |
| `--border-frame`  | `#2A3548` | Mobile device frame outline                        |

### Text

| Token              | Hex       | Use                                 |
| ------------------ | --------- | ----------------------------------- |
| `--text`           | `#F2F5FA` | Primary text                        |
| `--text-invert`    | `#FFFFFF` | Text on selected/accent surfaces    |
| `--text-secondary` | `#A9B4C7` | Secondary text, inactive nav labels |
| `--text-muted`     | `#7C8AA3` | Meta text, captions, inactive icons |
| `--text-dim`       | `#5F6D86` | Section eyebrow labels (uppercase)  |
| `--text-bright`    | `#D6DEEA` | Slightly brighter secondary         |

### Accent

| Token            | Hex       | Use                                   |
| ---------------- | --------- | ------------------------------------- |
| `--accent`       | `#6EA8FF` | Links, primary buttons, focus, badges |
| `--accent-hover` | `#8DBBFF` | Link hover                            |
| `--accent-soft`  | `#9CC2FF` | Active nav icon, accent text on dark  |
| `--accent-pale`  | `#CFE0FF` | Avatar initials on `#1B365D`          |
| `--accent-paler` | `#E6EEFF` | Highest-contrast accent text          |

### Status tones — `[background, foreground]`

| Tone    | BG        | FG        | Meaning                                                         |
| ------- | --------- | --------- | --------------------------------------------------------------- |
| `green` | `#14332A` | `#5EDBA0` | Approved / Acknowledged / Issued / Resolved / Filed / Available |
| `amber` | `#3A2D12` | `#F5C46B` | Pending / Awaiting approval / In progress / Open / On leave     |
| `red`   | `#3B1E1E` | `#F58C86` | Rejected / Failed / Overdue                                     |
| `blue`  | `#1B365D` | `#9CC2FF` | Reimbursed / Informational kind-chips                           |
| `gray`  | `#222D40` | `#A9B4C7` | Upcoming / Not applicable / Neutral                             |

### Department accents (directory avatars)

`Platform Engineering #1B365D` · `Design #3B2A5C` · `People Ops #14332A` ·
`Finance #3A2D12` · `Quality #1F3A45` · `Leadership #3B1E1E`
Departments beyond this list fall back to `--bg-selected` (`#1B365D`).

## 2. Typography

- Family: `'IBM Plex Sans', system-ui, sans-serif`; monospace `'IBM Plex Mono'`
  (reference numbers, amounts in tabular contexts).
- `-webkit-font-smoothing: antialiased`.
- Scale observed in the prototype:
  - Page/section heading: `15–20px / 600`
  - Card title: `14–15px / 600`
  - Body: `13–13.5px / 400–500`
  - Nav item: `13.5px / 500`
  - Meta / caption: `11.5–12px / 400`
  - Eyebrow (uppercase, `letter-spacing:.08em`): `10.5–11px / 500`
  - Status chip: `11px / 600`
  - Big metric value: `22–28px / 600`

## 3. Geometry

- Radius: `8px` buttons & nav items · `10px` icon buttons & inputs ·
  `12px` cards & panels · `999px` chips/badges · `50%` avatars ·
  `40px` mobile device frame.
- Border width: `1px` everywhere.
- Sidebar: `248px` expanded, `72px` collapsed.
- Top bar / mobile header min-height: `66px` / `~64px`.
- Content padding: desktop `28px 32px 40px`, compact `20px 16px 32px`.
- Card padding: `16–18px`. Gaps: `2px` nav items, `10–14px` groups, `16–20px` cards.
- Icon buttons: `40×40`. Avatars: `34px` (sidebar), `40px` (header), `36–44px` (lists).
- SVG icons: `20px` nav / `18px` inline, `stroke-width:1.7`, round caps & joins,
  `viewBox="0 0 24 24"`, `fill:none`.

## 4. Responsive behaviour (must be preserved)

Driven by a `ResizeObserver` on the shell and the main column, not media queries:

- **shell width < 880px → `compact`**: sidebar is replaced by a mobile header
  (logo · screen title · notifications · avatar), a bottom tab bar appears
  (Home, Payslips, Leave, Approvals|Profile, More), and "More" opens a sheet
  with the full nav.
- **main width < 820px → `narrow`**: two-column split layouts collapse to one
  column.
- `stack = compact || narrow` drives every grid:
  - `splitCols`: `340px minmax(0,1fr)` → `1fr` (list + detail)
  - `formCols`: `380px minmax(0,1fr)` → `1fr` (form + list)
  - `calCols`: `minmax(0,1fr) 340px` → `1fr` (main + aside)
  - `apprCols`: `minmax(0,1fr) 320px` → `1fr` (approvals + aside)
- Toast sits `bottom: 28px` desktop / `86px` compact (clear of the tab bar),
  centred, `animation: rise`.

## 5. Animations

```css
@keyframes rise {
  from {
    opacity: 0;
    transform: translate(-50%, 8px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}
@keyframes fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes sheet {
  from {
    transform: translateY(24px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}
```

## 6. Navigation model

Groups and order are fixed by the prototype:

| Group        | Items                                            |
| ------------ | ------------------------------------------------ |
| Overview     | Home                                             |
| Pay & tax    | Payslips, Tax slips                              |
| My workplace | My profile, Leave, Benefits, Expenses, Documents |
| Company      | Policies, Directory, Announcements               |
| Support      | Help desk                                        |
| Manager      | Approvals _(role-gated)_                         |

Additional production groups (HR / Accounts personas) are appended **after**
`Manager`, using the same group/item visual treatment, and are role-gated
server-side.

## 7. Component inventory (from the prototype)

Shell · collapsible sidebar with grouped nav + badge counts · sidebar user card ·
compact header · bottom tab bar · "More" sheet · global search with typed results
(Module / Person / Policy / Payslip) · notifications popover with colour dots ·
toast · metric tile (`k` / `v` / `sub`) · status chip · list+detail split ·
data table · progress bar (leave balance) · form card with inline error banner ·
accordion (FAQ) · timeline/reporting line · avatar with initials + department
colour · segmented tabs (underline for profile, filled pill for approvals) ·
empty state.

## 8. Empty states (mandatory)

Every list, table, card, chart and metric must render a designed empty state and
must never fabricate a value. Pattern used by the prototype ("No matches for …"):
centred block on `--bg-raised`, `1px dashed var(--border)`, radius `12px`,
padding `28–32px`, an outline glyph at `--text-dim`, a `13.5px/500 --text-secondary`
headline, a `12px --text-muted` explanation, and — where the user can act — one
secondary button. Metric tiles show `—` in `--text-muted` with the sub-label
explaining why the value is absent.

## 9. Iconography

The prototype's 24×24 stroke paths are reproduced verbatim in
`packages/shared` / the web icon module (keys: home, payslips, tax, profile,
leave, attendance, benefits, expenses, documents, policies, directory,
announcements, help, approvals, menu).

## 10. Locale

- Currency: INR, `'₹' + Math.round(n).toLocaleString('en-IN')` — no decimals in
  list/summary contexts; exact paise are kept in the database.
- Dates: `en-IN`, `{day:'numeric', month:'short', year:'numeric'}` → `29 Sep 2026`.
- Financial year: April–March; quarters Q1 Apr–Jun … Q4 Jan–Mar.

## 11. Data-integrity rule (overrides the prototype)

The prototype hard-codes sample values (`PAYSLIPS`, `PROFILE`, `PEOPLE`, `ANN`, …).
Those exist **only** to define layout and copy tone. In production every value,
count, amount, status, balance, metric, notification and number MUST come from
persisted data or a deterministic calculation over persisted data.
