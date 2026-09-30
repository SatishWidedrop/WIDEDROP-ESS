import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatDateTime, formatINR, toIsoDate } from '@widedrop/shared';
import { ApiError, api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { statusOf } from '../../lib/status.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { Icon } from '../../components/ui/Icon.js';
import { MetricGrid, MetricTile } from '../../components/ui/MetricTile.js';
import { PageHeader, SplitLayout, Stack } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { useToast } from '../../components/ui/Toast.js';
import { FieldRow, FormError, TextField } from '../../components/form/Field.js';
import styles from './PayrollCyclesScreen.module.css';

interface CycleSummary {
  id: string;
  label: string;
  year: number;
  month: number;
  status: string;
  runType: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  employeeCount: number | null;
  excludedCount: number | null;
  totalGrossMinor: string | null;
  totalNetMinor: string | null;
  payslipCount: number;
  inputBatchCount: number;
  attendancePeriod: { id: string; status: string } | null;
  stages: Record<string, string | null>;
  availableEvents: string[];
}

interface CycleDetail {
  id: string;
  label: string;
  status: string;
  runType: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  cancelReason: string | null;
  totals: {
    employeeCount: number | null;
    excludedCount: number | null;
    grossMinor: string | null;
    deductionsMinor: string | null;
    netMinor: string | null;
  };
  stages: {
    inputsLockedAt: string | null;
    attendanceSubmittedAt: string | null;
    attendanceApprovedAt: string | null;
    validatedAt: string | null;
    calculatedAt: string | null;
    approvedAt: string | null;
    publishedAt: string | null;
  };
  attendance: {
    id: string;
    label: string;
    status: string;
    recordCount: number;
    approvals: { manager: string; status: string; recordCount: number }[];
    pendingApprovals: number;
  } | null;
  inputBatches: {
    id: string;
    status: string;
    filename: string | null;
    rowCount: number;
    acceptedCount: number;
    rejectedCount: number;
    itemCount: number;
    createdAt: string;
    committedAt: string | null;
  }[];
  runs: {
    id: string;
    attempt: number;
    status: string;
    engineVersion: string;
    inputDigest: string | null;
    employeeCount: number | null;
    errorMessage: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  }[];
  validation: {
    attempt: number | null;
    blocking: ValidationGroup[];
    warnings: ValidationGroup[];
  };
  availableEvents: string[];
}

interface ValidationGroup {
  check: string;
  severity: string;
  label: string;
  remedy: string | null;
  employees: { id: string; fullName: string; employeeNumber: string; message: string }[];
}

/** The seven stages the requirement names, in order, with what each waits on. */
const STAGES = [
  { key: 'inputsLockedAt', label: 'Inputs locked', who: 'Accounts' },
  { key: 'attendanceSubmittedAt', label: 'Attendance submitted', who: 'People Ops' },
  { key: 'attendanceApprovedAt', label: 'Attendance approved', who: 'Managers' },
  { key: 'validatedAt', label: 'Validated', who: 'System' },
  { key: 'calculatedAt', label: 'Calculated', who: 'System' },
  { key: 'approvedAt', label: 'Approved', who: 'Accounts' },
  { key: 'publishedAt', label: 'Published', who: 'Accounts' },
] as const;

/** What each event's button should say, and how prominent it is. */
const EVENT_LABELS: Record<string, { label: string; variant: 'primary' | 'secondary' | 'danger' }> =
  {
    UPLOAD_INPUTS: { label: 'Upload inputs', variant: 'secondary' },
    LOCK_INPUTS: { label: 'Lock inputs', variant: 'primary' },
    REOPEN_INPUTS: { label: 'Reopen inputs', variant: 'secondary' },
    SUBMIT_ATTENDANCE: { label: 'Submit attendance', variant: 'primary' },
    RETURN_ATTENDANCE: { label: 'Return attendance', variant: 'secondary' },
    APPROVE_ATTENDANCE: { label: 'Approve attendance', variant: 'primary' },
    APPROVE: { label: 'Approve payroll', variant: 'primary' },
    PUBLISH: { label: 'Publish payslips', variant: 'primary' },
    CLOSE: { label: 'Close cycle', variant: 'secondary' },
    CANCEL: { label: 'Cancel cycle', variant: 'danger' },
  };

export function PayrollCyclesScreen() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const cycles = useQuery({
    queryKey: queryKeys.payroll.cycles,
    queryFn: () => api.get<{ items: CycleSummary[] }>('/api/v1/payroll/cycles'),
  });

  useEffect(() => {
    if (!selectedId && cycles.data?.items[0]) setSelectedId(cycles.data.items[0].id);
  }, [cycles.data, selectedId]);

  const detail = useQuery({
    queryKey: queryKeys.payroll.cycle(selectedId ?? ''),
    queryFn: () => api.get<CycleDetail>(`/api/v1/payroll/cycles/${selectedId}`),
    enabled: selectedId !== null,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['payroll'] });
    await queryClient.invalidateQueries({ queryKey: queryKeys.badges });
  };

  const transition = useMutation({
    mutationFn: (event: string) =>
      api.post<{ to: string }>(`/api/v1/payroll/cycles/${selectedId}/transition`, { event }),
    onSuccess: async (result) => {
      toast.success(`Cycle moved to ${statusOf(result.to).label.toLowerCase()}.`);
      await refresh();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'That step could not be taken.');
    },
  });

  const validate = useMutation({
    mutationFn: () =>
      api.post<{
        employeesInScope: number;
        employeesPassing: number;
        employeesExcluded: number;
        passed: boolean;
      }>(`/api/v1/payroll/cycles/${selectedId}/validate`, {}),
    onSuccess: async (result) => {
      if (result.passed) {
        toast.success(
          `${result.employeesPassing} of ${result.employeesInScope} employees cleared validation.`,
        );
      } else {
        toast.error(
          `${result.employeesExcluded} of ${result.employeesInScope} employees were excluded. See the findings below.`,
        );
      }
      await refresh();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Validation could not be run.');
    },
  });

  const calculate = useMutation({
    mutationFn: () =>
      api.post<{ payslipsCreated: number; skipped: { employeeId: string; reason: string }[] }>(
        `/api/v1/payroll/cycles/${selectedId}/calculate`,
        {},
      ),
    onSuccess: async (result) => {
      toast.success(
        `${result.payslipsCreated} payslips calculated${result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : ''}. They are not visible to employees until the cycle is published.`,
      );
      await refresh();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Payroll could not be calculated.');
    },
  });

  if (cycles.error)
    return <ErrorState error={cycles.error} onRetry={() => void cycles.refetch()} />;

  const items = cycles.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Payroll cycles"
        subtitle="Inputs → attendance → manager approval → validation → calculation → publication"
        actions={
          <Button variant={creating ? 'ghost' : 'primary'} onClick={() => setCreating((v) => !v)}>
            {creating ? 'Cancel' : 'New cycle'}
          </Button>
        }
      />

      {creating ? (
        <NewCycleForm
          onCreated={async (id) => {
            setCreating(false);
            setSelectedId(id);
            await refresh();
          }}
        />
      ) : null}

      {cycles.isPending ? (
        <Card>
          <SkeletonLines count={4} />
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon="payroll"
          title="No payroll cycles yet"
          body="Create the cycle for a month, upload the inputs, and the pipeline takes it from there. No payslip exists until the cycle is calculated, and none is visible until it is published."
        />
      ) : (
        <SplitLayout>
          <Card flush>
            {items.map((cycle) => (
              <DataRow
                key={cycle.id}
                title={cycle.label}
                meta={`Pay ${formatDate(cycle.payDate)}${cycle.payslipCount > 0 ? ` · ${cycle.payslipCount} payslips` : ''}`}
                value={cycle.totalNetMinor === null ? null : formatINR(Number(cycle.totalNetMinor))}
                selected={cycle.id === selectedId}
                onClick={() => setSelectedId(cycle.id)}
                trailing={<StatusChip {...statusOf(cycle.status)} />}
              />
            ))}
          </Card>

          {detail.error ? (
            <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
          ) : detail.isPending || !detail.data ? (
            <Card>
              <SkeletonLines count={8} />
            </Card>
          ) : (
            <CycleDetailView
              cycle={detail.data}
              busy={transition.isPending || validate.isPending || calculate.isPending}
              onEvent={(event) => transition.mutate(event)}
              onValidate={() => validate.mutate()}
              onCalculate={() => calculate.mutate()}
            />
          )}
        </SplitLayout>
      )}
    </>
  );
}

function CycleDetailView({
  cycle,
  busy,
  onEvent,
  onValidate,
  onCalculate,
}: {
  cycle: CycleDetail;
  busy: boolean;
  onEvent: (event: string) => void;
  onValidate: () => void;
  onCalculate: () => void;
}) {
  const status = statusOf(cycle.status);

  return (
    <Stack>
      <Card
        title={cycle.label}
        subtitle={`${formatDate(cycle.periodStart)} – ${formatDate(cycle.periodEnd)} · pay ${formatDate(cycle.payDate)}`}
        actions={<StatusChip {...status} />}
      >
        {/*
          The totals exist only once the cycle has been calculated. Before that
          they are null and render as em dashes: a row of ₹0 would say the
          organisation's payroll is nothing.
        */}
        <MetricGrid>
          <MetricTile
            label="Employees"
            value={cycle.totals.employeeCount === null ? null : String(cycle.totals.employeeCount)}
            sub={
              cycle.totals.excludedCount && cycle.totals.excludedCount > 0
                ? `${cycle.totals.excludedCount} excluded`
                : undefined
            }
            absentSub="after validation"
          />
          <MetricTile
            label="Gross"
            value={
              cycle.totals.grossMinor === null ? null : formatINR(Number(cycle.totals.grossMinor))
            }
            absentSub="after calculation"
          />
          <MetricTile
            label="Deductions"
            value={
              cycle.totals.deductionsMinor === null
                ? null
                : formatINR(Number(cycle.totals.deductionsMinor))
            }
            absentSub="after calculation"
          />
          <MetricTile
            label="Net payable"
            value={cycle.totals.netMinor === null ? null : formatINR(Number(cycle.totals.netMinor))}
            absentSub="after calculation"
          />
        </MetricGrid>

        {/* The pipeline, drawn from stored timestamps. A stage with no
            timestamp has not happened; nothing here is inferred. */}
        <ol className={styles.timeline}>
          {STAGES.map((stage) => {
            const at = cycle.stages[stage.key];
            return (
              <li key={stage.key} className={`${styles.stage} ${at ? styles.stageDone : ''}`}>
                <span className={styles.stageDot} aria-hidden="true">
                  {at ? <Icon name="check" size={11} /> : null}
                </span>
                <span className={styles.stageBody}>
                  <span className={styles.stageLabel}>{stage.label}</span>
                  <span className={styles.stageMeta}>
                    {at ? formatDateTime(at) : `waiting on ${stage.who}`}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>

        {cycle.cancelReason ? (
          <p className={styles.cancelled}>Cancelled: {cycle.cancelReason}</p>
        ) : null}

        <div className={styles.actions}>
          {/* Only what the server would allow. The list comes from the same
              state machine the API enforces, so no button 403s. */}
          {cycle.status === 'ATTENDANCE_APPROVED' || cycle.status === 'VALIDATION_FAILED' ? (
            <Button variant="primary" busy={busy} onClick={onValidate}>
              Run validation
            </Button>
          ) : null}

          {cycle.status === 'VALIDATED' ? (
            <Button variant="primary" busy={busy} onClick={onCalculate}>
              Calculate payroll
            </Button>
          ) : null}

          {cycle.availableEvents.map((event) => {
            const definition = EVENT_LABELS[event];
            if (!definition) return null;
            // Uploading inputs happens on its own screen.
            if (event === 'UPLOAD_INPUTS') return null;
            return (
              <Button
                key={event}
                variant={definition.variant}
                busy={busy}
                onClick={() => onEvent(event)}
              >
                {definition.label}
              </Button>
            );
          })}
        </div>
      </Card>

      {/* Attendance, and who is holding it up. */}
      {cycle.attendance ? (
        <Card
          title="Attendance"
          subtitle={`${cycle.attendance.label} · ${cycle.attendance.recordCount} records`}
          actions={<StatusChip {...statusOf(cycle.attendance.status)} />}
          flush
        >
          {cycle.attendance.approvals.length === 0 ? (
            <EmptyState
              compact
              icon="attendance"
              title="Not submitted yet"
              body="People Ops submits the period, and every manager with people in it approves their slice before payroll may consume it."
            />
          ) : (
            cycle.attendance.approvals.map((approval) => (
              <DataRow
                key={approval.manager}
                title={approval.manager}
                meta={`${approval.recordCount} ${approval.recordCount === 1 ? 'person' : 'people'}`}
                trailing={<StatusChip {...statusOf(approval.status)} />}
              />
            ))
          )}
        </Card>
      ) : (
        <Card title="Attendance">
          <EmptyState
            compact
            icon="attendance"
            title="No attendance period linked"
            body="People Ops opens the period for this month; the cycle picks it up automatically."
          />
        </Card>
      )}

      {/* The validation findings, grouped by cause. */}
      {cycle.validation.blocking.length > 0 || cycle.validation.warnings.length > 0 ? (
        <Card
          title="Validation findings"
          subtitle={
            cycle.validation.attempt !== null ? `Attempt ${cycle.validation.attempt}` : undefined
          }
        >
          {[...cycle.validation.blocking, ...cycle.validation.warnings].map((group) => (
            <div key={group.check} className={styles.finding}>
              <div className={styles.findingHead}>
                <StatusChip
                  label={group.severity === 'ERROR' ? 'Blocking' : 'Warning'}
                  tone={group.severity === 'ERROR' ? 'red' : 'amber'}
                />
                <span className={styles.findingLabel}>{group.label}</span>
                <span className={styles.findingCount}>
                  {group.employees.length} {group.employees.length === 1 ? 'person' : 'people'}
                </span>
              </div>
              {group.remedy ? <p className={styles.findingRemedy}>{group.remedy}</p> : null}
              <ul className={styles.findingList}>
                {group.employees.slice(0, 12).map((employee) => (
                  <li key={employee.id}>
                    {employee.fullName} ({employee.employeeNumber}) — {employee.message}
                  </li>
                ))}
                {group.employees.length > 12 ? (
                  <li className={styles.findingMore}>and {group.employees.length - 12} more</li>
                ) : null}
              </ul>
            </div>
          ))}
        </Card>
      ) : null}

      <Card title="Input batches" flush>
        {cycle.inputBatches.length === 0 ? (
          <EmptyState
            compact
            icon="upload"
            title="No inputs uploaded"
            body="Incentives, arrears, one-off deductions and recoveries are uploaded before the cycle is locked."
          />
        ) : (
          cycle.inputBatches.map((batch) => (
            <DataRow
              key={batch.id}
              title={batch.filename ?? 'Entered in the portal'}
              meta={[
                `${batch.itemCount} ${batch.itemCount === 1 ? 'row' : 'rows'}`,
                batch.rejectedCount > 0 ? `${batch.rejectedCount} rejected` : null,
                batch.committedAt
                  ? `committed ${formatDateTime(batch.committedAt)}`
                  : 'not committed',
              ]
                .filter(Boolean)
                .join(' · ')}
              trailing={<StatusChip {...statusOf(batch.status)} />}
            />
          ))
        )}
      </Card>

      {cycle.runs.length > 0 ? (
        <Card
          title="Calculation runs"
          subtitle="Each run records the engine and its input digest"
          flush
        >
          {cycle.runs.map((run) => (
            <DataRow
              key={run.id}
              title={`Attempt ${run.attempt} · ${run.engineVersion}`}
              meta={[
                run.employeeCount !== null ? `${run.employeeCount} employees` : null,
                run.inputDigest ? `digest ${run.inputDigest.slice(0, 12)}` : null,
                run.finishedAt ? formatDateTime(run.finishedAt) : null,
                run.errorMessage,
              ]
                .filter(Boolean)
                .join(' · ')}
              trailing={<StatusChip {...statusOf(run.status)} />}
            />
          ))}
        </Card>
      ) : null}
    </Stack>
  );
}

function NewCycleForm({ onCreated }: { onCreated: (id: string) => Promise<void> }) {
  const today = new Date();
  const [year, setYear] = useState(String(today.getUTCFullYear()));
  const [month, setMonth] = useState(String(today.getUTCMonth() + 1));
  const [payDate, setPayDate] = useState(
    toIsoDate(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0))),
  );
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string; label: string }>('/api/v1/payroll/cycles', {
        year: Number(year),
        month: Number(month),
        payDate,
      }),
    onSuccess: async (created) => {
      setError(null);
      await onCreated(created.id);
    },
    onError: (failure: unknown) => {
      setError(failure instanceof ApiError ? failure.message : 'That cycle could not be created.');
    },
  });

  return (
    <Card title="New payroll cycle">
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <FieldRow>
          <TextField
            label="Year"
            type="number"
            min="2000"
            max="2100"
            value={year}
            onChange={(event) => setYear(event.target.value)}
          />
          <TextField
            label="Month"
            type="number"
            min="1"
            max="12"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
          />
          <TextField
            label="Pay date"
            type="date"
            value={payDate}
            onChange={(event) => setPayDate(event.target.value)}
          />
        </FieldRow>

        <FormError message={error} />

        <Button type="submit" variant="primary" busy={create.isPending}>
          Create cycle
        </Button>
      </form>
    </Card>
  );
}
