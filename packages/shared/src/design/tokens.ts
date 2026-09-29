/**
 * Design tokens extracted verbatim from the supplied prototype
 * (`design/prototype/Widedrop-Employee-Portal.bundled.html`) and documented in
 * `design/DESIGN-SYSTEM.md`.
 *
 * These are the single source of truth for the palette. The web app emits them
 * as CSS custom properties on `:root`; nothing may introduce a colour that is
 * not listed here.
 */

export const surface = {
  /** Outermost page background. */
  page: '#070B12',
  /** App shell / content background. */
  shell: '#0F1622',
  /** Sidebar, top bar, cards, popovers. */
  panel: '#121B2B',
  /** Inset rows, table headers, form fields, wells. */
  raised: '#172236',
  /** Row / list-item hover. */
  hover: '#1D2A42',
  /** Sidebar nav item hover. */
  hoverNav: '#1A2538',
  /** Selected nav item, selected row, active tab. */
  selected: '#1B365D',
  /** Text colour on an accent-filled badge. */
  onAccent: '#0B1729',
} as const;

export const border = {
  /** Default border for cards, inputs, buttons. */
  base: '#263247',
  /** Structural dividers (sidebar edge, top bar bottom). */
  subtle: '#1F2A3D',
  /** Scrollbar thumb, emphasised dividers. */
  strong: '#2F3D55',
  /** Mobile device frame outline. */
  frame: '#2A3548',
} as const;

export const text = {
  primary: '#F2F5FA',
  invert: '#FFFFFF',
  bright: '#D6DEEA',
  secondary: '#A9B4C7',
  muted: '#7C8AA3',
  dim: '#5F6D86',
} as const;

export const accent = {
  base: '#6EA8FF',
  hover: '#8DBBFF',
  soft: '#9CC2FF',
  pale: '#CFE0FF',
  paler: '#E6EEFF',
} as const;

/** Status tone names used by chips, dots and metric emphasis. */
export const TONES = ['green', 'amber', 'red', 'blue', 'gray'] as const;
export type Tone = (typeof TONES)[number];

/** `[background, foreground]` for each tone, as the prototype defines them. */
export const tone: Record<Tone, { bg: string; fg: string }> = {
  green: { bg: '#14332A', fg: '#5EDBA0' },
  amber: { bg: '#3A2D12', fg: '#F5C46B' },
  red: { bg: '#3B1E1E', fg: '#F58C86' },
  blue: { bg: '#1B365D', fg: '#9CC2FF' },
  gray: { bg: '#222D40', fg: '#A9B4C7' },
};

/**
 * Department accent colours for directory avatars. Departments outside this map
 * fall back to `surface.selected` — a deterministic fallback, never a random or
 * invented colour.
 */
export const DEPARTMENT_COLOR: Record<string, string> = {
  'Platform Engineering': '#1B365D',
  Design: '#3B2A5C',
  'People Ops': '#14332A',
  Finance: '#3A2D12',
  Quality: '#1F3A45',
  Leadership: '#3B1E1E',
};

export const DEPARTMENT_COLOR_FALLBACK = surface.selected;

/**
 * Resolve a department's avatar colour deterministically: the configured colour
 * when the department is known, otherwise a stable hash-derived pick from the
 * same palette, so the same department always renders the same way.
 */
export function departmentColor(department: string | null | undefined): string {
  if (!department) return DEPARTMENT_COLOR_FALLBACK;
  const configured = DEPARTMENT_COLOR[department];
  if (configured) return configured;
  const palette = Object.values(DEPARTMENT_COLOR);
  let hash = 0;
  for (let i = 0; i < department.length; i += 1) {
    hash = (hash * 31 + department.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length] ?? DEPARTMENT_COLOR_FALLBACK;
}

export const font = {
  sans: "'IBM Plex Sans', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

export const radius = {
  /** Buttons, nav items. */
  sm: '8px',
  /** Icon buttons, inputs. */
  md: '10px',
  /** Cards, panels. */
  lg: '12px',
  /** Chips, badges, progress bars. */
  pill: '999px',
  /** Avatars. */
  circle: '50%',
} as const;

/**
 * Container-width breakpoints. The prototype drives these from a
 * `ResizeObserver` on the shell and on the main column rather than from media
 * queries, so the layout responds to its container and not to the viewport.
 */
export const breakpoint = {
  /** Shell narrower than this collapses the sidebar into a mobile header + tab bar. */
  compact: 880,
  /** Main column narrower than this collapses split layouts to a single column. */
  narrow: 820,
} as const;

/** Grid templates for the four split layouts, expanded and stacked. */
export const gridTemplate = {
  /** List + detail (payslips, policies, announcements). */
  split: { wide: '340px minmax(0, 1fr)', stacked: '1fr' },
  /** Form + list (leave, help desk). */
  form: { wide: '380px minmax(0, 1fr)', stacked: '1fr' },
  /** Main + aside (leave calendar, home). */
  calendar: { wide: 'minmax(0, 1fr) 340px', stacked: '1fr' },
  /** Approvals queue + aside. */
  approvals: { wide: 'minmax(0, 1fr) 320px', stacked: '1fr' },
} as const;

export const layout = {
  sidebarWidth: '248px',
  sidebarWidthCollapsed: '72px',
  contentPadding: '28px 32px 40px',
  contentPaddingCompact: '20px 16px 32px',
  toastBottom: '28px',
  toastBottomCompact: '86px',
} as const;
