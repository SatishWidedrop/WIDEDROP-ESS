import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '@widedrop/shared';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { statusOf } from '../../lib/status.js';
import { Avatar } from '../../components/ui/Avatar.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { Detail, DetailGrid } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { PageHeader } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { useToast } from '../../components/ui/Toast.js';
import { TextAreaField } from '../../components/form/Field.js';
import styles from './AttendanceScreen.module.css';

interface AttendanceResponse {
  periods: { id: string; label: string; year: number; month: number; status: string }[];
  period: {
    id: string;
    label: string;
    startDate: string;
    endDate: string;
    totalDays: number;
    status: string;
    submittedAt: string | null;
    approvedAt: string | null;
  } | null;
  records: {
    id: string;
    status: string;
    source: string;
    employee: { id: string; fullName: string; initials: string; employeeNumber: string };
    managerEmployeeId: string | null;
    presentDays: number;
    paidLeaveDays: number;
    unpaidLeaveDays: number;
    holidayDays: number;
    weekOffDays: number;
    absentDays: number;
    payableDays: number;
    lopDays: number;
    employedDays: number;
    note: string | null;
  }[];
  myApproval: {
    id: string;
    status: string;
    recordCount: number;
    decidedAt: string | null;
    returnReason: string | null;
  } | null;
  canCorrect: boolean;
  canSubmit: boolean;
}

/**
 * Attendance, for whoever is looking.
 *
 * The same screen serves an employee (their own months), a manager (their
 * slice, with the approve and return actions) and HR (the whole organisation,
 * with derive and submit). The server decides which records come back and
 * which actions are permitted; this renders what it was given.
 */
export function AttendanceScreen({ variant }: { variant: 'self' | 'team' | 'hr' }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [periodId, setPeriodId] = useState<string | undefined>();
  const [returnReason, setReturnReason] = useState('');

  const attendance = useQuery({
    queryKey: queryKeys.attendance.mine(periodId),
    queryFn: () =>
      api.get<AttendanceResponse>('/api/v1/attendance', {
        query: { periodId: periodId ?? undefined },
      }),
  });

  const approvals = useQuery({
    queryKey: ['attendance', 'approvals', attendance.data?.period?.id],
    queryFn: () =>
      api.get<{
        items: {
          id: string;
          status: string;
          recordCount: number;
          decidedAt: string | null;
          returnReason: string | null;
          manager: { id: string; fullName: string; initials: string };
        }[];
        pending: number;
      }>(`/api/v1/hr/attendance/periods/${attendance.data?.period?.id}/approvals`),
    enabled: variant === 'hr' && attendance.data?.period?.id !== undefined,
    retry: false,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['attendance'] });
    await queryClient.invalidateQueries({ queryKey: queryKeys.badges });
  };

  const derive = useMutation({
    mutationFn: (id: string) =>
      api.post<{ created: number; updated: number; skipped: number }>(
        `/api/v1/hr/attendance/periods/${id}/derive`,
        {},
      ),
    onSuccess: async (result) => {
      toast.success(
        `${result.created} created, ${result.updated} refreshed${result.skipped > 0 ? `, ${result.skipped} left as corrected` : ''}.`,
      );
      await refresh();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Attendance could not be derived.');
    },
  });

  const submit = useMutation({
    mutationFn: (id: string) =>
      api.post<{ managerCount: number; recordCount: number }>(
        `/api/v1/hr/attendance/periods/${id}/submit`,
        {},
      ),
    onSuccess: async (result) => {
      toast.success(
        `Submitted ${result.recordCount} records to ${result.managerCount} ${result.managerCount === 1 ? 'manager' : 'managers'}.`,
      );
      await refresh();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'That period could not be submitted.');
    },
  });

  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      api.post<{ periodStatus: string; remaining: number }>(
        `/api/v1/attendance/periods/${id}/decide`,
        {
          decision: approve ? 'APPROVE' : 'RETURN',
          ...(approve ? {} : { returnReason: returnReason.trim() }),
        },
      ),
    onSuccess: async (result, variables) => {
      setReturnReason('');
      toast.success(
        variables.approve
          ? result.remaining > 0
            ? `Approved. ${result.remaining} ${result.remaining === 1 ? 'manager' : 'managers'} still to decide.`
            : 'Approved. The period is now ready for payroll.'
          : 'Returned to People Ops.',
      );
      await refresh();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'That decision could not be recorded.');
    },
  });

  const createPeriod = useMutation({
    mutationFn: () => {
      const now = new Date();
      return api.post<{ id: string }>('/api/v1/hr/attendance/periods', {
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 1,
      });
    },
    onSuccess: async (created) => {
      setPeriodId(created.id);
      toast.success('Period opened.');
      await refresh();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'That period could not be opened.');
    },
  });

  if (attendance.error) {
    return <ErrorState error={attendance.error} onRetry={() => void attendance.refetch()} />;
  }

  const data = attendance.data;
  const period = data?.period;
  const title =
    variant === 'self' ? 'My attendance' : variant === 'team' ? 'Team attendance' : 'Attendance';

  return (
    <>
      <PageHeader
        title={title}
        subtitle={
          period
            ? `${period.label} · ${period.totalDays} days in the period`
            : 'Days are derived from the calendar and your approved leave, then confirmed'
        }
        badge={period ? <StatusChip {...statusOf(period.status)} /> : null}
        actions={
          <>
            {(data?.periods.length ?? 0) > 0 ? (
              <select
                className={styles.select}
                value={periodId ?? period?.id ?? ''}
                onChange={(event) => setPeriodId(event.target.value)}
                aria-label="Attendance period"
              >
                {data?.periods.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.label}
                  </option>
                ))}
              </select>
            ) : null}

            {variant === 'hr' && data?.canCorrect ? (
              <>
                <Button
                  variant="ghost"
                  busy={createPeriod.isPending}
                  onClick={() => createPeriod.mutate()}
                >
                  Open this month
                </Button>
                {period && ['OPEN', 'REOPENED'].includes(period.status) ? (
                  <Button
                    variant="secondary"
                    busy={derive.isPending}
                    onClick={() => derive.mutate(period.id)}
                  >
                    Derive from leave
                  </Button>
                ) : null}
                {period && ['OPEN', 'REOPENED'].includes(period.status) && data.canSubmit ? (
                  <Button
                    variant="primary"
                    busy={submit.isPending}
                    onClick={() => submit.mutate(period.id)}
                  >
                    Submit for approval
                  </Button>
                ) : null}
              </>
            ) : null}
          </>
        }
      />

      {attendance.isPending ? (
        <Card>
          <SkeletonLines count={5} />
        </Card>
      ) : !period ? (
        <EmptyState
          icon="attendance"
          title="No attendance period open"
          body={
            variant === 'hr'
              ? 'Open the month to start. Records are derived from the holiday calendar, joining dates and approved leave.'
              : 'People Ops opens each month and submits it for your manager to approve.'
          }
        />
      ) : (
        <>
          <DetailGrid>
            <Detail label="Period" value={period.label} />
            <Detail label="Records" value={`${data.records.length}`} />
            <Detail
              label="Submitted"
              value={period.submittedAt ? formatDateTime(period.submittedAt) : null}
            />
            <Detail
              label="Approved"
              value={period.approvedAt ? formatDateTime(period.approvedAt) : null}
            />
          </DetailGrid>

          {/* The manager's own slice, with the decision it is waiting for. */}
          {data.myApproval ? (
            <Card
              title="Your slice"
              subtitle={`${data.myApproval.recordCount} ${data.myApproval.recordCount === 1 ? 'person' : 'people'} reporting to you`}
              actions={<StatusChip {...statusOf(data.myApproval.status)} />}
            >
              {data.myApproval.status === 'PENDING' ? (
                <div className={styles.decision}>
                  <TextAreaField
                    label="What needs correcting"
                    optional
                    rows={2}
                    value={returnReason}
                    maxLength={1000}
                    onChange={(event) => setReturnReason(event.target.value)}
                    hint="Required when returning the period to People Ops"
                  />
                  <div className={styles.decisionActions}>
                    <Button
                      variant="primary"
                      busy={decide.isPending && decide.variables?.approve === true}
                      onClick={() => decide.mutate({ id: period.id, approve: true })}
                    >
                      Approve my slice
                    </Button>
                    <Button
                      variant="danger"
                      disabled={returnReason.trim().length === 0}
                      busy={decide.isPending && decide.variables?.approve === false}
                      onClick={() => decide.mutate({ id: period.id, approve: false })}
                    >
                      Return to People Ops
                    </Button>
                  </div>
                </div>
              ) : data.myApproval.returnReason ? (
                <p className={styles.returned}>You returned this: {data.myApproval.returnReason}</p>
              ) : (
                <p className={styles.note}>
                  Decided{' '}
                  {data.myApproval.decidedAt ? formatDateTime(data.myApproval.decidedAt) : ''}
                </p>
              )}
            </Card>
          ) : null}

          {/* HR's view of who is holding the period up. */}
          {variant === 'hr' && approvals.data ? (
            <Card
              title="Manager approvals"
              subtitle={
                approvals.data.pending > 0
                  ? `${approvals.data.pending} still to decide`
                  : 'Everyone has decided'
              }
              flush
            >
              {approvals.data.items.length === 0 ? (
                <EmptyState
                  compact
                  icon="approvals"
                  title="Not submitted yet"
                  body="Approvals are raised when the period is submitted."
                />
              ) : (
                <div className={styles.table}>
                  {approvals.data.items.map((approval) => (
                    <div key={approval.id} className={styles.tableRow}>
                      <span className={styles.cellName}>
                        <Avatar initials={approval.manager.initials} size={28} />
                        {approval.manager.fullName}
                      </span>
                      <span className={styles.cell}>
                        {approval.recordCount} {approval.recordCount === 1 ? 'person' : 'people'}
                      </span>
                      <span className={styles.cell}>
                        {approval.decidedAt ? formatDateTime(approval.decidedAt) : '—'}
                      </span>
                      <span className={styles.cell}>
                        <StatusChip {...statusOf(approval.status)} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ) : null}

          <Card
            title={variant === 'self' ? 'My days' : 'Records'}
            subtitle="Payable days plus loss of pay equals the days employed"
            flush
          >
            {data.records.length === 0 ? (
              <EmptyState
                compact
                icon="attendance"
                title="No records yet"
                body={
                  variant === 'hr'
                    ? 'Derive the period to create one record per employee from the calendar and their approved leave.'
                    : 'People Ops derives the records for each month.'
                }
              />
            ) : (
              <div className={styles.table}>
                <div className={`${styles.tableRow} ${styles.tableHead}`}>
                  <span className={styles.cellName}>Employee</span>
                  <span className={styles.cellNumber}>Present</span>
                  <span className={styles.cellNumber}>Paid leave</span>
                  <span className={styles.cellNumber}>Week off</span>
                  <span className={styles.cellNumber}>Holiday</span>
                  <span className={styles.cellNumber}>Loss of pay</span>
                  <span className={styles.cellNumber}>Payable</span>
                </div>
                {data.records.map((record) => (
                  <div key={record.id} className={styles.tableRow}>
                    <span className={styles.cellName}>
                      <Avatar initials={record.employee.initials} size={26} />
                      <span className={styles.nameText}>
                        {record.employee.fullName}
                        <span className={styles.nameMeta}>{record.employee.employeeNumber}</span>
                      </span>
                    </span>
                    <span className={styles.cellNumber}>{record.presentDays}</span>
                    <span className={styles.cellNumber}>{record.paidLeaveDays}</span>
                    <span className={styles.cellNumber}>{record.weekOffDays}</span>
                    <span className={styles.cellNumber}>{record.holidayDays}</span>
                    <span
                      className={`${styles.cellNumber} ${record.lopDays > 0 ? styles.lop : ''}`}
                    >
                      {record.lopDays}
                    </span>
                    <span className={`${styles.cellNumber} ${styles.cellStrong}`}>
                      {record.payableDays} / {record.employedDays}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}
