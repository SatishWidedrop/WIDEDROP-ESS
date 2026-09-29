import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';
import { queryKeys } from './queryKeys.js';

/**
 * Explanatory copy, from the database.
 *
 * Empty-state headlines, tab notes and captions are rows HR can edit, not
 * strings compiled into the bundle. The fallbacks below exist so a screen is
 * never blank if a key has not been seeded — they are the same words, not
 * placeholders.
 */
const FALLBACKS: Record<string, string> = {
  'empty.payslips.title': 'No payslips yet',
  'empty.payslips.body':
    'Your payslip appears here once payroll for the period has been processed and published.',
  'empty.home.todo.title': 'Nothing needs your attention',
  'empty.home.todo.body': 'Policy acknowledgements and approvals waiting on you appear here.',
  'empty.leave.balances.title': 'No leave balances set up',
  'empty.leave.balances.body': 'People Ops sets your entitlement when the leave year opens.',
  'empty.holidays.title': 'No holidays published',
  'empty.holidays.body':
    'The holiday calendar for your location appears here once People Ops publishes it.',
  'empty.announcements.title': 'No announcements',
  'empty.announcements.body': 'Company announcements appear here as they are published.',
  'empty.approvals.title': 'Nothing waiting on you',
  'empty.approvals.body':
    'Leave and expense requests from your team appear here when they need a decision.',
  'value.none': '—',
};

export function useUiCopy() {
  const { data } = useQuery({
    queryKey: queryKeys.uiCopy,
    queryFn: () => api.get<Record<string, string>>('/api/v1/ui-copy'),
    // Copy changes rarely and is needed by every screen, so it is cached for
    // the session rather than refetched per screen.
    staleTime: 30 * 60_000,
    retry: false,
  });

  return (key: string): string => data?.[key] ?? FALLBACKS[key] ?? key;
}
