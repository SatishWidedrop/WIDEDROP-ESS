import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatDateTime, formatINR, rupeesToPaise } from '@widedrop/shared';
import { ApiError, api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { statusOf } from '../../lib/status.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { PageHeader, SplitLayout, Stack } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { useToast } from '../../components/ui/Toast.js';
import { FieldRow, FormError, SelectField, TextField } from '../../components/form/Field.js';
import styles from './PayrollInputsScreen.module.css';

const KINDS = [
  { value: 'INCENTIVE', label: 'Incentive' },
  { value: 'BONUS', label: 'Bonus' },
  { value: 'VARIABLE_PAY', label: 'Variable pay' },
  { value: 'ARREAR', label: 'Arrear' },
  { value: 'REIMBURSEMENT_PAYOUT', label: 'Reimbursement payout' },
  { value: 'ONE_OFF_DEDUCTION', label: 'One-off deduction' },
  { value: 'ADVANCE_RECOVERY', label: 'Advance recovery' },
] as const;

interface Cycle {
  id: string;
  label: string;
  status: string;
  payDate: string;
  inputBatchCount: number;
}

interface PendingLine {
  key: number;
  employeeId: string;
  employeeLabel: string;
  kind: string;
  amount: string;
  note: string;
}

export function PayrollInputsScreen() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [cycleId, setCycleId] = useState('');
  const [lines, setLines] = useState<PendingLine[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<string>('INCENTIVE');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState<{ id: string; label: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const cycles = useQuery({
    queryKey: queryKeys.payroll.cycles,
    queryFn: () => api.get<{ items: Cycle[] }>('/api/v1/payroll/cycles'),
  });

  // Only a cycle whose inputs are still open can take a batch. Anything else
  // would be refused, so it is not offered.
  const open = (cycles.data?.items ?? []).filter((cycle) =>
    ['DRAFT', 'INPUTS_OPEN'].includes(cycle.status),
  );

  const employees = useQuery({
    queryKey: ['hr', 'employees', query],
    queryFn: () =>
      api.get<{
        items: {
          id: string;
          fullName: string;
          employeeNumber: string;
          department: string | null;
        }[];
      }>('/api/v1/hr/employees', { query: { q: query, limit: 20 } }),
    enabled: query.trim().length >= 2,
    retry: false,
  });

  const upload = useMutation({
    mutationFn: () =>
      api.post<{ id: string; rowCount: number }>('/api/v1/payroll/inputs', {
        payrollCycleId: cycleId || open[0]?.id,
        items: lines.map((line) => ({
          employeeId: line.employeeId,
          kind: line.kind,
          amountMinor: rupeesToPaise(Number(line.amount)),
          ...(line.note.trim() ? { note: line.note.trim() } : {}),
        })),
      }),
    onSuccess: async (result) => {
      setError(null);
      setLines([]);
      toast.success(`${result.rowCount} ${result.rowCount === 1 ? 'row' : 'rows'} committed.`);
      await queryClient.invalidateQueries({ queryKey: ['payroll'] });
    },
    onError: (failure: unknown) => {
      setError(failure instanceof ApiError ? failure.message : 'That batch could not be uploaded.');
    },
  });

  if (cycles.error)
    return <ErrorState error={cycles.error} onRetry={() => void cycles.refetch()} />;

  const total = lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0);

  function addLine() {
    if (!selectedEmployee || !(Number(amount) > 0)) return;
    setLines((current) => [
      ...current,
      {
        key: nextKey,
        employeeId: selectedEmployee.id,
        employeeLabel: selectedEmployee.label,
        kind,
        amount,
        note,
      },
    ]);
    setNextKey((key) => key + 1);
    setAmount('');
    setNote('');
  }

  return (
    <>
      <PageHeader
        title="Payroll inputs"
        subtitle="Incentives, arrears, one-off deductions and recoveries, entered against a cycle before its inputs are locked"
      />

      {cycles.isPending ? (
        <Card>
          <SkeletonLines count={3} />
        </Card>
      ) : open.length === 0 ? (
        <EmptyState
          icon="upload"
          title="No cycle is open for inputs"
          body="Create a cycle, or reopen the inputs on one whose inputs are already locked. A locked cycle cannot take new rows, because payroll has already been told what it was paying."
        />
      ) : (
        <SplitLayout variant="form">
          <Stack>
            <Card title="Add a row">
              <div className={styles.form}>
                <SelectField
                  label="Cycle"
                  value={cycleId || open[0]?.id}
                  onChange={(event) => setCycleId(event.target.value)}
                >
                  {open.map((cycle) => (
                    <option key={cycle.id} value={cycle.id}>
                      {cycle.label} · pay {formatDate(cycle.payDate)}
                    </option>
                  ))}
                </SelectField>

                <TextField
                  label="Employee"
                  type="search"
                  value={selectedEmployee ? selectedEmployee.label : query}
                  placeholder="Name or employee number"
                  onChange={(event) => {
                    setSelectedEmployee(null);
                    setQuery(event.target.value);
                  }}
                  hint={selectedEmployee ? 'Selected' : 'Type at least two characters'}
                />

                {!selectedEmployee && (employees.data?.items.length ?? 0) > 0 ? (
                  <div className={styles.results}>
                    {employees.data?.items.map((employee) => (
                      <button
                        key={employee.id}
                        type="button"
                        className={styles.result}
                        onClick={() => {
                          setSelectedEmployee({
                            id: employee.id,
                            label: `${employee.fullName} (${employee.employeeNumber})`,
                          });
                          setQuery('');
                        }}
                      >
                        <span>{employee.fullName}</span>
                        <span className={styles.resultMeta}>
                          {employee.employeeNumber}
                          {employee.department ? ` · ${employee.department}` : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}

                <FieldRow>
                  <SelectField
                    label="Kind"
                    value={kind}
                    onChange={(event) => setKind(event.target.value)}
                  >
                    {KINDS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </SelectField>
                  <TextField
                    label="Amount (₹)"
                    type="number"
                    min="1"
                    step="0.01"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                </FieldRow>

                <TextField
                  label="Note"
                  optional
                  value={note}
                  maxLength={300}
                  placeholder="What this is for, printed on the payslip line"
                  onChange={(event) => setNote(event.target.value)}
                />

                <Button
                  variant="secondary"
                  disabled={!selectedEmployee || !(Number(amount) > 0)}
                  onClick={addLine}
                >
                  Add to batch
                </Button>
              </div>
            </Card>
          </Stack>

          <Card
            title="Batch"
            subtitle={
              lines.length > 0
                ? `${lines.length} ${lines.length === 1 ? 'row' : 'rows'} · ${formatINR(rupeesToPaise(total))}`
                : 'Nothing staged yet'
            }
            flush
          >
            {lines.length === 0 ? (
              <EmptyState
                compact
                icon="upload"
                title="No rows staged"
                body="Add rows on the left. Nothing reaches payroll until the batch is committed, and a committed batch is part of the audit trail."
              />
            ) : (
              <>
                {lines.map((line) => (
                  <DataRow
                    key={line.key}
                    title={line.employeeLabel}
                    meta={[KINDS.find((k) => k.value === line.kind)?.label, line.note]
                      .filter(Boolean)
                      .join(' · ')}
                    value={formatINR(rupeesToPaise(Number(line.amount)))}
                    trailing={
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={() =>
                          setLines((current) => current.filter((l) => l.key !== line.key))
                        }
                      >
                        Remove
                      </Button>
                    }
                  />
                ))}

                <div className={styles.commit}>
                  <FormError message={error} />
                  <Button variant="primary" busy={upload.isPending} onClick={() => upload.mutate()}>
                    Commit batch
                  </Button>
                  <span className={styles.note}>
                    Committing moves the cycle to inputs-open and records who uploaded what.
                  </span>
                </div>
              </>
            )}
          </Card>
        </SplitLayout>
      )}

      <BatchHistory cycles={cycles.data?.items ?? []} />
    </>
  );
}

function BatchHistory({ cycles }: { cycles: Cycle[] }) {
  const withBatches = cycles.filter((cycle) => cycle.inputBatchCount > 0).slice(0, 6);
  const [expanded, setExpanded] = useState<string | null>(withBatches[0]?.id ?? null);

  const detail = useQuery({
    queryKey: queryKeys.payroll.cycle(expanded ?? ''),
    queryFn: () =>
      api.get<{
        inputBatches: {
          id: string;
          status: string;
          filename: string | null;
          itemCount: number;
          committedAt: string | null;
        }[];
      }>(`/api/v1/payroll/cycles/${expanded}`),
    enabled: expanded !== null,
  });

  if (withBatches.length === 0) return null;

  return (
    <Card title="Uploaded batches" flush>
      {withBatches.map((cycle) => (
        <div key={cycle.id}>
          <DataRow
            title={cycle.label}
            meta={`${cycle.inputBatchCount} ${cycle.inputBatchCount === 1 ? 'batch' : 'batches'}`}
            selected={cycle.id === expanded}
            onClick={() => setExpanded(cycle.id === expanded ? null : cycle.id)}
            trailing={<StatusChip {...statusOf(cycle.status)} />}
          />
          {cycle.id === expanded && detail.data
            ? detail.data.inputBatches.map((batch) => (
                <DataRow
                  key={batch.id}
                  title={batch.filename ?? 'Entered in the portal'}
                  meta={[
                    `${batch.itemCount} ${batch.itemCount === 1 ? 'row' : 'rows'}`,
                    batch.committedAt ? formatDateTime(batch.committedAt) : 'not committed',
                  ].join(' · ')}
                  trailing={<StatusChip {...statusOf(batch.status)} />}
                />
              ))
            : null}
        </div>
      ))}
    </Card>
  );
}
