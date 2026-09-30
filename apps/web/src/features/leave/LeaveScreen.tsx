import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, formatDate, formatDateRange, toIsoDate } from '@widedrop/shared';
import { ApiError, api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { statusOf } from '../../lib/status.js';
import { useUiCopy } from '../../lib/uiCopy.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow, Meter } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { useToast } from '../../components/ui/Toast.js';
import {
  FieldRow,
  FormError,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/form/Field.js';
import styles from './LeaveScreen.module.css';

interface LeaveBalance {
  id: string;
  typeId: string;
  code: string;
  name: string;
  isPaid: boolean;
  consumedDays: number;
  reservedDays: number;
  availableDays: number;
  entitlementDays: number;
}

interface LeaveType {
  id: string;
  code: string;
  name: string;
  isPaid: boolean;
  allowsHalfDay: boolean;
  minNoticeDays: number;
  documentRequiredAfterDays: number | null;
  requiresApproval: boolean;
}

interface LeaveOverview {
  period: {
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    isClosed: boolean;
  } | null;
  balances: LeaveBalance[];
  types: LeaveType[];
  holidays: { id: string; name: string; date: string; kind: string }[];
  upcoming: {
    id: string;
    status: string;
    startDate: string;
    endDate: string;
    workingDays: number;
    typeName: string;
  }[];
}

interface LeaveRequestRow {
  id: string;
  status: string;
  startDate: string;
  endDate: string;
  workingDays: number;
  reason: string | null;
  decisionNote: string | null;
  type: { id: string; name: string; code: string; isPaid: boolean };
  employee: { id: string; fullName: string; initials: string };
  canWithdraw: boolean;
}

interface Preview {
  workingDays: number;
  days: { date: string; portion: string }[];
  excluded: { holidays: string[] };
}

export function LeaveScreen() {
  const copy = useUiCopy();
  const toast = useToast();
  const queryClient = useQueryClient();

  const overview = useQuery({
    queryKey: queryKeys.leave.balances,
    queryFn: () => api.get<LeaveOverview>('/api/v1/leave'),
  });

  const requests = useQuery({
    queryKey: queryKeys.leave.requests(),
    queryFn: () => api.get<{ items: LeaveRequestRow[] }>('/api/v1/leave/requests'),
  });

  if (overview.error) {
    return <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />;
  }

  const data = overview.data;
  const mine = (requests.data?.items ?? []).filter((request) => request.employee.id !== undefined);

  async function withdraw(id: string) {
    try {
      await api.post(`/api/v1/leave/requests/${id}/withdraw`, {});
      toast.success('Request withdrawn.');
      await queryClient.invalidateQueries({ queryKey: ['leave'] });
      await queryClient.invalidateQueries({ queryKey: queryKeys.badges });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That could not be withdrawn.');
    }
  }

  return (
    <>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Leave</h1>
          <p className={styles.subtitle}>
            {data?.period
              ? `Balances, requests and holidays · ${data.period.name}`
              : 'Balances, requests and holidays'}
          </p>
        </div>
      </div>

      {overview.isPending ? (
        <Card>
          <SkeletonLines count={3} />
        </Card>
      ) : !data?.period ? (
        <EmptyState
          icon="leave"
          title={copy('empty.leave.balances.title')}
          body={copy('empty.leave.balances.body')}
        />
      ) : (
        <>
          {data.balances.length > 0 ? (
            <div className={styles.balances}>
              {data.balances.map((balance) => (
                <BalanceCard key={balance.id} balance={balance} />
              ))}
            </div>
          ) : (
            <Card>
              <EmptyState
                compact
                icon="leave"
                title={copy('empty.leave.balances.title')}
                body={copy('empty.leave.balances.body')}
              />
            </Card>
          )}

          <div className={styles.split}>
            <ApplyForm
              types={data.types}
              periodClosed={data.period.isClosed}
              onApplied={async () => {
                await queryClient.invalidateQueries({ queryKey: ['leave'] });
                await queryClient.invalidateQueries({ queryKey: queryKeys.badges });
              }}
            />

            <div className={styles.stack}>
              <Card title="My requests" flush>
                {requests.isPending ? (
                  <div className={styles.padded}>
                    <SkeletonLines count={3} />
                  </div>
                ) : mine.length === 0 ? (
                  <EmptyState
                    compact
                    icon="leave"
                    title="No requests yet"
                    body="Leave you apply for appears here, with where it has got to."
                  />
                ) : (
                  mine.map((request) => {
                    const status = statusOf(request.status);
                    return (
                      <DataRow
                        key={request.id}
                        title={`${request.type.name} · ${formatDateRange(request.startDate, request.endDate)}`}
                        meta={[
                          `${request.workingDays} ${request.workingDays === 1 ? 'day' : 'days'}`,
                          request.decisionNote ?? request.reason,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        trailing={
                          <>
                            {request.canWithdraw ? (
                              <Button
                                size="small"
                                variant="ghost"
                                onClick={() => void withdraw(request.id)}
                              >
                                Withdraw
                              </Button>
                            ) : null}
                            <StatusChip label={status.label} tone={status.tone} />
                          </>
                        }
                      />
                    );
                  })
                )}
              </Card>

              <Card title="Upcoming holidays" flush>
                {data.holidays.length === 0 ? (
                  <EmptyState
                    compact
                    icon="leave"
                    title={copy('empty.holidays.title')}
                    body={copy('empty.holidays.body')}
                  />
                ) : (
                  data.holidays
                    .slice(0, 8)
                    .map((holiday) => (
                      <DataRow
                        key={holiday.id}
                        title={holiday.name}
                        meta={holiday.kind === 'RESTRICTED' ? 'Restricted holiday' : null}
                        value={formatDate(holiday.date)}
                      />
                    ))
                )}
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function BalanceCard({ balance }: { balance: LeaveBalance }) {
  // The bar is used-of-entitlement. With no entitlement the bar is empty and
  // the number says so, rather than a full bar implying everything is spent.
  const used = balance.consumedDays + balance.reservedDays;

  return (
    <div className={styles.balance}>
      <div className={styles.balanceName}>{balance.name}</div>
      <div className={styles.balanceValue}>
        {balance.availableDays}
        <span className={styles.balanceTotal}>
          {' '}
          / {balance.entitlementDays} {balance.entitlementDays === 1 ? 'day' : 'days'}
        </span>
      </div>
      <Meter
        value={used}
        max={balance.entitlementDays}
        label={`${balance.name}: ${used} of ${balance.entitlementDays} days used`}
        tone={balance.availableDays <= 0 ? 'red' : 'accent'}
      />
      {balance.reservedDays > 0 ? (
        <div className={styles.balanceNote}>
          {balance.reservedDays} {balance.reservedDays === 1 ? 'day' : 'days'} held by a pending
          request
        </div>
      ) : null}
    </div>
  );
}

function ApplyForm({
  types,
  periodClosed,
  onApplied,
}: {
  types: LeaveType[];
  periodClosed: boolean;
  onApplied: () => Promise<void>;
}) {
  const toast = useToast();
  const today = toIsoDate(new Date());

  const [leaveTypeId, setLeaveTypeId] = useState(types[0]?.id ?? '');
  const [startDate, setStartDate] = useState(addDays(today, 1));
  const [endDate, setEndDate] = useState(addDays(today, 1));
  const [startPortion, setStartPortion] = useState('FULL');
  const [endPortion, setEndPortion] = useState('FULL');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const selected = types.find((type) => type.id === leaveTypeId);

  // The day count comes from the server, computed by the same code the
  // submission will use. The client never counts days itself, so the preview
  // cannot promise a number the submission then contradicts.
  const preview = useQuery({
    queryKey: ['leave', 'preview', { leaveTypeId, startDate, endDate, startPortion, endPortion }],
    queryFn: () =>
      api.post<Preview>('/api/v1/leave/preview', {
        leaveTypeId,
        startDate,
        endDate,
        startPortion,
        endPortion,
      }),
    enabled: leaveTypeId !== '' && endDate >= startDate,
    retry: false,
  });

  const submit = useMutation({
    mutationFn: () =>
      api.post<{ id: string; workingDays: number }>('/api/v1/leave/requests', {
        leaveTypeId,
        startDate,
        endDate,
        startPortion,
        endPortion,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    onSuccess: async (created) => {
      setError(null);
      setReason('');
      toast.success(
        `Requested ${created.workingDays} ${created.workingDays === 1 ? 'day' : 'days'}. Your manager has been notified.`,
      );
      await onApplied();
    },
    onError: (failure: unknown) => {
      setError(
        failure instanceof ApiError
          ? failure.message
          : 'That request could not be submitted. Try again.',
      );
    },
  });

  if (types.length === 0) {
    return (
      <Card title="Apply for leave">
        <EmptyState
          compact
          icon="leave"
          title="No leave types set up"
          body="People Ops configures the kinds of leave before requests can be made."
        />
      </Card>
    );
  }

  return (
    <Card title="Apply for leave">
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          submit.mutate();
        }}
      >
        <SelectField
          label="Leave type"
          value={leaveTypeId}
          onChange={(event) => {
            setLeaveTypeId(event.target.value);
            setStartPortion('FULL');
            setEndPortion('FULL');
          }}
        >
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
              {type.isPaid ? '' : ' (unpaid)'}
            </option>
          ))}
        </SelectField>

        <FieldRow>
          <TextField
            label="From"
            type="date"
            value={startDate}
            min={today}
            onChange={(event) => {
              setStartDate(event.target.value);
              if (event.target.value > endDate) setEndDate(event.target.value);
            }}
          />
          <TextField
            label="To"
            type="date"
            value={endDate}
            min={startDate}
            onChange={(event) => setEndDate(event.target.value)}
          />
        </FieldRow>

        {selected?.allowsHalfDay ? (
          <FieldRow>
            <SelectField
              label="First day"
              value={startPortion}
              onChange={(event) => setStartPortion(event.target.value)}
            >
              <option value="FULL">Full day</option>
              <option value="FIRST_HALF">First half</option>
              <option value="SECOND_HALF">Second half</option>
            </SelectField>
            <SelectField
              label="Last day"
              value={endPortion}
              onChange={(event) => setEndPortion(event.target.value)}
              disabled={startDate === endDate}
            >
              <option value="FULL">Full day</option>
              <option value="FIRST_HALF">First half</option>
              <option value="SECOND_HALF">Second half</option>
            </SelectField>
          </FieldRow>
        ) : null}

        <TextAreaField
          label="Reason"
          optional
          rows={3}
          value={reason}
          maxLength={1000}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Shared with your manager"
        />

        <FormError message={error} />

        {periodClosed ? (
          <p className={styles.note}>
            The leave year is closed. People Ops opens the next one before requests can be made.
          </p>
        ) : null}

        <div className={styles.actions}>
          <Button type="submit" variant="primary" busy={submit.isPending} disabled={periodClosed}>
            Submit request
          </Button>
          <span className={styles.note}>
            {preview.data
              ? preview.data.workingDays > 0
                ? `${preview.data.workingDays} working ${preview.data.workingDays === 1 ? 'day' : 'days'}${
                    preview.data.excluded.holidays.length > 0
                      ? ` · ${preview.data.excluded.holidays.length} ${
                          preview.data.excluded.holidays.length === 1 ? 'holiday' : 'holidays'
                        } excluded`
                      : ''
                  }`
                : 'Those dates are all weekends or holidays'
              : 'Weekends and holidays are not counted'}
          </span>
        </div>

        {selected?.documentRequiredAfterDays !== null &&
        selected?.documentRequiredAfterDays !== undefined &&
        (preview.data?.workingDays ?? 0) > selected.documentRequiredAfterDays ? (
          <p className={styles.note}>
            {selected.name} beyond {selected.documentRequiredAfterDays} days needs a certificate.
            People Ops will ask for it.
          </p>
        ) : null}
      </form>
    </Card>
  );
}
