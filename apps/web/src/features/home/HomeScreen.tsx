import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { EMPTY_VALUE, formatDate, formatINR, type Tone } from '@widedrop/shared';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { useUiCopy } from '../../lib/uiCopy.js';
import { useCurrentUser } from '../../app/AuthProvider.js';
import { Avatar } from '../../components/ui/Avatar.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import styles from './HomeScreen.module.css';

interface HomeData {
  latestPayslip: {
    id: string;
    reference: string;
    label: string;
    payDate: string;
    netPayMinor: string;
    hasDocument: boolean;
  } | null;
  leaveBalances: {
    code: string;
    name: string;
    availableDays: number;
    entitlementDays: number;
  }[];
  todos: { kind: string; id: string; title: string; sub: string; tone: Tone; path: string }[];
  announcements: {
    id: string;
    title: string;
    department: string;
    byline: string | null;
    publishedAt: string | null;
    isPinned: boolean;
  }[];
  holidays: { id: string; name: string; date: string; kind: string }[];
  team: {
    id: string;
    name: string;
    initials: string;
    title: string | null;
    department: string | null;
    onLeaveToday: boolean;
  }[];
  pendingApprovals: number;
  fiscalYear: string;
}

const TONE_COLOR: Record<Tone, string> = {
  green: 'var(--tone-green-fg)',
  amber: 'var(--tone-amber-fg)',
  red: 'var(--tone-red-fg)',
  blue: 'var(--accent-soft)',
  gray: 'var(--text-muted)',
};

export function HomeScreen() {
  const user = useCurrentUser();
  const copy = useUiCopy();

  const { data, isPending, error, refetch } = useQuery({
    queryKey: queryKeys.home,
    queryFn: () => api.get<HomeData>('/api/v1/me/home'),
  });

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <>
      <div className={styles.greeting}>
        <h1 className={styles.greetingTitle}>
          {greeting()}, {user.displayName.split(' ')[0]}
        </h1>
        <p className={styles.greetingSub}>
          {[user.designation, user.department].filter(Boolean).join(' · ') ||
            'Welcome to your employee portal'}
        </p>
      </div>

      <div className={styles.split}>
        <div className={styles.column}>
          <Card title="Waiting on you">
            {isPending ? (
              <SkeletonLines count={2} />
            ) : data && data.todos.length > 0 ? (
              <div>
                {data.todos.map((todo) => (
                  <Link key={`${todo.kind}-${todo.id}`} to={todo.path} className={styles.todo}>
                    <span
                      className={styles.todoDot}
                      style={{ background: TONE_COLOR[todo.tone] }}
                      aria-hidden="true"
                    />
                    <span className={styles.todoText}>
                      <span className={styles.todoTitle}>{todo.title}</span>
                      {todo.sub ? <span className={styles.todoSub}>{todo.sub}</span> : null}
                    </span>
                    <Button variant="ghost" size="small" tabIndex={-1}>
                      Review
                    </Button>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState
                icon="check"
                compact
                title={copy('empty.home.todo.title')}
                body={copy('empty.home.todo.body')}
              />
            )}
          </Card>

          <Card
            title="Latest payslip"
            actions={
              data?.latestPayslip ? (
                <Link to="/payslips">
                  <Button variant="ghost" size="small">
                    All payslips
                  </Button>
                </Link>
              ) : undefined
            }
          >
            {isPending ? (
              <SkeletonLines count={2} />
            ) : data?.latestPayslip ? (
              <div className={styles.payslip}>
                <div>
                  <div className={styles.payslipAmount}>
                    {formatINR(Number(data.latestPayslip.netPayMinor))}
                  </div>
                  <div className={styles.payslipMeta}>Net pay · {data.latestPayslip.label}</div>
                </div>
                <div className={styles.payslipMeta}>
                  Credited {formatDate(data.latestPayslip.payDate)}
                  <br />
                  Reference {data.latestPayslip.reference}
                </div>
                {/*
                  The download is offered only when the document exists. A
                  button that produces nothing is worse than no button.
                */}
                {data.latestPayslip.hasDocument ? (
                  <Link to={`/payslips?payslip=${data.latestPayslip.id}`}>
                    <Button variant="secondary" icon="download">
                      Download
                    </Button>
                  </Link>
                ) : null}
              </div>
            ) : (
              <EmptyState
                icon="payslips"
                compact
                title={copy('empty.payslips.title')}
                body={copy('empty.payslips.body')}
              />
            )}
          </Card>

          <Card
            title="Announcements"
            actions={
              <Link to="/announcements">
                <Button variant="ghost" size="small">
                  All
                </Button>
              </Link>
            }
          >
            {isPending ? (
              <SkeletonLines count={3} />
            ) : data && data.announcements.length > 0 ? (
              <div>
                {data.announcements.map((announcement) => (
                  <Link
                    key={announcement.id}
                    to={`/announcements?id=${announcement.id}`}
                    className={styles.listItem}
                  >
                    <span className={styles.todoText}>
                      <span className={styles.listTitle}>{announcement.title}</span>
                      <span className={styles.listMeta}>
                        {[
                          announcement.byline ?? announcement.department,
                          announcement.publishedAt
                            ? formatDate(announcement.publishedAt.slice(0, 10))
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    {announcement.isPinned ? <StatusChip label="Pinned" tone="blue" /> : null}
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState
                icon="announcements"
                compact
                title={copy('empty.announcements.title')}
                body={copy('empty.announcements.body')}
              />
            )}
          </Card>
        </div>

        <div className={styles.column}>
          <Card
            title="Leave balance"
            actions={
              <Link to="/leave">
                <Button variant="ghost" size="small">
                  Apply
                </Button>
              </Link>
            }
          >
            {isPending ? (
              <SkeletonLines count={3} />
            ) : data && data.leaveBalances.length > 0 ? (
              <div className={styles.balances}>
                {data.leaveBalances.slice(0, 4).map((balance) => {
                  // A percentage is only meaningful against a real entitlement;
                  // with none set, the bar is empty rather than full or invented.
                  const percent =
                    balance.entitlementDays > 0
                      ? Math.min(
                          100,
                          Math.max(0, (balance.availableDays / balance.entitlementDays) * 100),
                        )
                      : 0;
                  return (
                    <div key={balance.code} className={styles.balance}>
                      <div className={styles.balanceHead}>
                        <span className={styles.balanceName}>{balance.name}</span>
                        <span className={styles.balanceValue}>
                          {balance.entitlementDays > 0
                            ? `${balance.availableDays} of ${balance.entitlementDays} days`
                            : `${balance.availableDays} days`}
                        </span>
                      </div>
                      <div
                        className={styles.bar}
                        role="progressbar"
                        aria-valuenow={balance.availableDays}
                        aria-valuemin={0}
                        aria-valuemax={balance.entitlementDays || balance.availableDays}
                        aria-label={`${balance.name} remaining`}
                      >
                        <div className={styles.barFill} style={{ width: `${percent}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                icon="leave"
                compact
                title={copy('empty.leave.balances.title')}
                body={copy('empty.leave.balances.body')}
              />
            )}
          </Card>

          <Card title="Upcoming holidays">
            {isPending ? (
              <SkeletonLines count={3} />
            ) : data && data.holidays.length > 0 ? (
              <div>
                {data.holidays.map((holiday) => {
                  const [, month, day] = holiday.date.split('-');
                  return (
                    <div key={holiday.id} className={styles.listItem}>
                      <span className={styles.dateBlock}>
                        <span className={styles.dateDay}>{Number(day)}</span>
                        <span className={styles.dateMonth}>{monthName(Number(month))}</span>
                      </span>
                      <span className={styles.todoText}>
                        <span className={styles.listTitle}>{holiday.name}</span>
                        <span className={styles.listMeta}>
                          {holiday.kind === 'RESTRICTED' ? 'Restricted holiday' : 'Public holiday'}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                icon="leave"
                compact
                title={copy('empty.holidays.title')}
                body={copy('empty.holidays.body')}
              />
            )}
          </Card>

          {user.personas.includes('MANAGER') ? (
            <Card
              title="Your team"
              subtitle={
                data
                  ? `${data.team.length} ${data.team.length === 1 ? 'person' : 'people'}`
                  : undefined
              }
            >
              {isPending ? (
                <SkeletonLines count={3} />
              ) : data && data.team.length > 0 ? (
                <div>
                  {data.team.map((member) => (
                    <div key={member.id} className={styles.teamRow}>
                      <Avatar
                        initials={member.initials}
                        department={member.department}
                        name={member.name}
                        size={36}
                      />
                      <span className={styles.teamInfo}>
                        <span className={styles.teamName}>{member.name}</span>
                        <span className={styles.teamTitle}>{member.title ?? EMPTY_VALUE}</span>
                      </span>
                      <StatusChip
                        label={member.onLeaveToday ? 'On leave' : 'Available'}
                        tone={member.onLeaveToday ? 'amber' : 'green'}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon="employees"
                  compact
                  title="Nobody reports to you yet"
                  body="People Ops sets the reporting line. Your team appears here once it is in place."
                />
              )}
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

/** Local time of day, which is a property of the reader's clock, not the server's. */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function monthName(month: number): string {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    month - 1
  ]!;
}
