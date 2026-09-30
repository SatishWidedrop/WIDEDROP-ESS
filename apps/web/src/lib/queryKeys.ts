/**
 * Query keys.
 *
 * Centralised so an invalidation cannot miss a cache entry by spelling a key
 * differently from the fetch that filled it — the usual cause of a screen that
 * shows a stale number after a successful save.
 */
export const queryKeys = {
  me: ['me'] as const,
  badges: ['badges'] as const,
  notifications: (unreadOnly = false) => ['notifications', { unreadOnly }] as const,

  home: ['home'] as const,

  payslips: {
    list: (fiscalYear?: number) => ['payslips', 'list', { fiscalYear }] as const,
    detail: (id: string) => ['payslips', 'detail', id] as const,
    rollup: (fiscalYear?: number) => ['payslips', 'rollup', { fiscalYear }] as const,
  },

  tax: {
    summary: (fiscalYear?: number) => ['tax', 'summary', { fiscalYear }] as const,
    quarters: (fiscalYear?: number) => ['tax', 'quarters', { fiscalYear }] as const,
    form16: ['tax', 'form16'] as const,
    declaration: (fiscalYear?: number) => ['tax', 'declaration', { fiscalYear }] as const,
  },

  profile: {
    detail: (section: string) => ['profile', section] as const,
    changeRequests: ['profile', 'change-requests'] as const,
  },

  leave: {
    balances: ['leave', 'balances'] as const,
    requests: (status?: string) => ['leave', 'requests', { status }] as const,
    types: ['leave', 'types'] as const,
    holidays: (year?: number) => ['leave', 'holidays', { year }] as const,
  },

  benefits: {
    enrolments: ['benefits', 'enrolments'] as const,
    dependents: ['benefits', 'dependents'] as const,
  },

  expenses: {
    list: (status?: string) => ['expenses', 'list', { status }] as const,
    categories: ['expenses', 'categories'] as const,
    rollup: ['expenses', 'rollup'] as const,
    attachments: (claimId: string) => ['expenses', 'attachments', claimId] as const,
  },

  documents: {
    list: ['documents', 'list'] as const,
    requests: ['documents', 'requests'] as const,
    types: ['documents', 'types'] as const,
  },

  policies: {
    list: ['policies', 'list'] as const,
    detail: (id: string) => ['policies', 'detail', id] as const,
  },

  directory: {
    search: (query: string) => ['directory', 'search', { query }] as const,
    person: (id: string) => ['directory', 'person', id] as const,
    reportingLine: ['directory', 'reporting-line'] as const,
  },

  announcements: {
    list: ['announcements', 'list'] as const,
    detail: (id: string) => ['announcements', 'detail', id] as const,
  },

  help: {
    tickets: (status?: string) => ['help', 'tickets', { status }] as const,
    ticket: (id: string) => ['help', 'ticket', id] as const,
    categories: ['help', 'categories'] as const,
    faqs: ['help', 'faqs'] as const,
  },

  approvals: {
    pending: ['approvals', 'pending'] as const,
    history: ['approvals', 'history'] as const,
  },

  attendance: {
    periods: ['attendance', 'periods'] as const,
    period: (id: string) => ['attendance', 'period', id] as const,
    mine: (periodId?: string) => ['attendance', 'mine', { periodId }] as const,
  },

  payroll: {
    cycles: ['payroll', 'cycles'] as const,
    cycle: (id: string) => ['payroll', 'cycle', id] as const,
    validation: (cycleId: string) => ['payroll', 'validation', cycleId] as const,
    batches: (cycleId: string) => ['payroll', 'batches', cycleId] as const,
  },

  audit: {
    events: (filters: Record<string, unknown>) => ['audit', 'events', filters] as const,
    verification: ['audit', 'verification'] as const,
  },

  uiCopy: ['ui-copy'] as const,
} as const;
