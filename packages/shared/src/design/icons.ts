/**
 * Icon path data reproduced verbatim from the prototype's `I` map.
 *
 * Every icon is a 24×24 stroke outline drawn with `fill="none"`,
 * `stroke-width="1.7"` and round caps/joins — see `design/DESIGN-SYSTEM.md` §9.
 */
export const ICON_PATHS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  payslips: 'M5 3h14v18l-2.5-1.8L14 21l-2-1.6L10 21l-2.5-1.8L5 21zM9 8h6M9 12h6M9 16h3',
  tax: 'M6 3h9l4 4v14H6zM15 3v4h4M9.5 16.5l5-5M10 11.5h.01M14.5 16h.01',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  leave: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  attendance: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  benefits: 'M12 21s-7-4.5-7-11a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 6.5-7 11-7 11z',
  expenses:
    'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7V5a2 2 0 0 1 2-2h11v4M16 14h.01',
  documents: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h5M10 17h5',
  policies: 'M5 4h13a1 1 0 0 1 1 1v14H7a2 2 0 0 0-2 2zM5 4v17M9 8h6',
  directory:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20a7 7 0 0 1 14 0M16 4a3.5 3.5 0 0 1 0 7M22 20a7 7 0 0 0-5-6.7',
  announcements: 'M3 10v4l11 4V6zM14 9a3 3 0 0 1 0 6M7 14v5h3v-4',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01',
  approvals: 'M9 12l2 2 4-4M4 4h16v16H4z',
  menu: 'M4 7h16M4 12h16M4 17h16',

  // Additional icons for the HR and Accounts surfaces and shared UI. Drawn in
  // the same 24×24 / 1.7-stroke outline language as the prototype's set.
  payroll:
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 0 1 5 0M14.5 15a2.5 2.5 0 0 1-5 0M12 6.5v11',
  upload: 'M12 16V4M7.5 8.5L12 4l4.5 4.5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2',
  download: 'M12 4v12M7.5 11.5L12 16l4.5-4.5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2',
  employees:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20a7 7 0 0 1 14 0M16 4a3.5 3.5 0 0 1 0 7M22 20a7 7 0 0 0-5-6.7',
  audit: 'M7 3h7l5 5v13H7zM14 3v5h5M10 12h5M10 16h3M10 8h2',
  reimbursements: 'M3 7h18v12H3zM3 11h18M7 15h4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  bell: 'M6 8a6 6 0 0 1 12 0v5l2 3H4l2-3zM10 20a2 2 0 0 0 4 0',
  close: 'M6 6l12 12M18 6L6 18',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  check: 'M5 12.5l4.5 4.5L19 7',
  alert:
    'M12 8v5M12 16.5h.01M10.3 3.9L2.5 17.4A1.5 1.5 0 0 0 3.8 19.7h16.4a1.5 1.5 0 0 0 1.3-2.3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 7.5h.01',
  inbox: 'M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z',
  logout: 'M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4M16 16l4-4-4-4M20 12H9',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 14H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7.5l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.6V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.5 1.5l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];
