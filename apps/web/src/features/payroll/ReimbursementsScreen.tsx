import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatDateTime, formatINR, rupeesToPaise, toIsoDate } from '@widedrop/shared';
import { ApiError, api } from '../../lib/api.js';
import { statusOf } from '../../lib/status.js';
import { Avatar } from '../../components/ui/Avatar.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow, Reference } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { PageHeader, Stack } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { TabPanel, Tabs } from '../../components/ui/Tabs.js';
import { useToast } from '../../components/ui/Toast.js';
import { FieldRow, FormError, SelectField, TextField } from '../../components/form/Field.js';
import styles from './ReimbursementsScreen.module.css';

interface ReimbursementsResponse {
  awaitingFinance: {
    id: string;
    reference: string;
    title: string;
    totalAmountMinor: string;
    spendDate: string;
    managerDecidedAt: string | null;
    managerNote: string | null;
    employee: { id: string; fullName: string; initials: string; employeeNumber: string };
    attachmentCount: number;
    lines: { id: string; description: string; amountMinor: string; category: string }[];
  }[];
  awaitingPayment: {
    id: string;
    reference: string;
    title: string;
    status: string;
    payableMinor: string;
    financeDecidedAt: string | null;
    batchId: string | null;
    employee: { id: string; fullName: string; initials: string };
  }[];
  batches: {
    id: string;
    reference: string;
    status: string;
    cutoffDate: string;
    claimCount: number;
    totalAmountMinor: string;
    lockedAt: string | null;
    paidAt: string | null;
    cycle: { id: string; label: string; payDate: string; status: string } | null;
  }[];
  cycles: { id: string; label: string; payDate: string; status: string }[];
}

export function ReimbursementsScreen() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('review');

  const data = useQuery({
    queryKey: ['payroll', 'reimbursements'],
    queryFn: () => api.get<ReimbursementsResponse>('/api/v1/payroll/reimbursements'),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['payroll'] });

  const decide = useMutation({
    mutationFn: (input: { id: string; approve: boolean; approvedRupees?: string; note?: string }) =>
      api.post(`/api/v1/payroll/reimbursements/claims/${input.id}/decide`, {
        decision: input.approve ? 'APPROVE' : 'REJECT',
        ...(input.note ? { note: input.note } : {}),
        ...(input.approve && input.approvedRupees
          ? { approvedAmountMinor: rupeesToPaise(Number(input.approvedRupees)) }
          : {}),
      }),
    onSuccess: async (_result, variables) => {
      toast.success(variables.approve ? 'Approved for payment.' : 'Declined.');
      await refresh();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'That decision could not be recorded.');
    },
  });

  const pay = useMutation({
    mutationFn: (id: string) =>
      api.post<{ claimCount: number }>(`/api/v1/payroll/reimbursements/batches/${id}/pay`, {}),
    onSuccess: async (result) => {
      toast.success(
        `${result.claimCount} ${result.claimCount === 1 ? 'claim' : 'claims'} marked reimbursed.`,
      );
      await refresh();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'That batch could not be paid.');
    },
  });

  if (data.error) return <ErrorState error={data.error} onRetry={() => void data.refetch()} />;

  const response = data.data;

  return (
    <>
      <PageHeader
        title="Reimbursements"
        subtitle="Approved claims are batched against a payroll cycle, and the batch is what makes the payment date a fact"
        actions={
          <Tabs
            label="Reimbursement stages"
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'review', label: 'To review', count: response?.awaitingFinance.length },
              { id: 'batches', label: 'Batches' },
            ]}
          />
        }
      />

      <TabPanel id="review" active={tab}>
        {data.isPending ? (
          <Card>
            <SkeletonLines count={4} />
          </Card>
        ) : (response?.awaitingFinance.length ?? 0) === 0 ? (
          <EmptyState
            icon="reimbursements"
            title="Nothing waiting on Accounts"
            body="Claims a manager has approved appear here for the bills and the caps to be checked."
          />
        ) : (
          <Stack>
            {response?.awaitingFinance.map((claim) => (
              <ClaimReview
                key={claim.id}
                claim={claim}
                busy={decide.isPending}
                onDecide={(input) => decide.mutate({ id: claim.id, ...input })}
              />
            ))}
          </Stack>
        )}
      </TabPanel>

      <TabPanel id="batches" active={tab}>
        <Stack>
          <NewBatchForm cycles={response?.cycles ?? []} onCreated={refresh} />

          <Card title="Approved, not yet batched" flush>
            {(response?.awaitingPayment.filter((claim) => claim.batchId === null).length ?? 0) ===
            0 ? (
              <EmptyState
                compact
                icon="reimbursements"
                title="Nothing waiting to be batched"
                body="A claim Accounts approves waits here until it is batched against a payroll cycle."
              />
            ) : (
              response?.awaitingPayment
                .filter((claim) => claim.batchId === null)
                .map((claim) => (
                  <DataRow
                    key={claim.id}
                    leading={<Reference>{claim.reference}</Reference>}
                    title={claim.title}
                    meta={`${claim.employee.fullName}${claim.financeDecidedAt ? ` · approved ${formatDate(claim.financeDecidedAt.slice(0, 10))}` : ''}`}
                    value={formatINR(Number(claim.payableMinor))}
                    trailing={<StatusChip {...statusOf(claim.status)} />}
                  />
                ))
            )}
          </Card>

          <Card title="Batches" flush>
            {(response?.batches.length ?? 0) === 0 ? (
              <EmptyState
                compact
                icon="reimbursements"
                title="No batches yet"
                body="A batch gathers approved claims up to a cut-off and attaches them to the cycle that will pay them."
              />
            ) : (
              response?.batches.map((batch) => (
                <DataRow
                  key={batch.id}
                  leading={<Reference>{batch.reference}</Reference>}
                  title={
                    batch.cycle
                      ? `Paying with ${batch.cycle.label} on ${formatDate(batch.cycle.payDate)}`
                      : 'Not attached to a cycle'
                  }
                  meta={[
                    `${batch.claimCount} ${batch.claimCount === 1 ? 'claim' : 'claims'}`,
                    `cut-off ${formatDate(batch.cutoffDate)}`,
                    batch.paidAt ? `paid ${formatDateTime(batch.paidAt)}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  value={formatINR(Number(batch.totalAmountMinor))}
                  trailing={
                    <>
                      <StatusChip {...statusOf(batch.status)} />
                      {/* Offered only once the cycle has published: telling
                          someone they have been paid before the money moves is
                          the one thing this screen must not do. */}
                      {batch.status !== 'PAID' &&
                      batch.status !== 'CANCELLED' &&
                      (!batch.cycle || ['PUBLISHED', 'CLOSED'].includes(batch.cycle.status)) ? (
                        <Button
                          size="small"
                          variant="primary"
                          busy={pay.isPending}
                          onClick={() => pay.mutate(batch.id)}
                        >
                          Mark paid
                        </Button>
                      ) : null}
                    </>
                  }
                />
              ))
            )}
          </Card>
        </Stack>
      </TabPanel>
    </>
  );
}

function ClaimReview({
  claim,
  busy,
  onDecide,
}: {
  claim: ReimbursementsResponse['awaitingFinance'][number];
  busy: boolean;
  onDecide: (input: { approve: boolean; approvedRupees?: string; note?: string }) => void;
}) {
  const claimed = Number(claim.totalAmountMinor);
  const [approvedRupees, setApprovedRupees] = useState(String(claimed / 100));
  const [note, setNote] = useState('');

  const reduced = rupeesToPaise(Number(approvedRupees)) !== claimed;

  return (
    <Card
      title={claim.title}
      subtitle={`${claim.reference} · ${claim.employee.fullName} (${claim.employee.employeeNumber}) · spent ${formatDate(claim.spendDate)}`}
      actions={
        <Avatar initials={claim.employee.initials} name={claim.employee.fullName} size={34} />
      }
    >
      <div className={styles.lines}>
        {claim.lines.map((line) => (
          <div key={line.id} className={styles.line}>
            <span>
              <span className={styles.lineTitle}>{line.description}</span>
              <span className={styles.lineMeta}>{line.category}</span>
            </span>
            <span className={styles.lineAmount}>{formatINR(Number(line.amountMinor))}</span>
          </div>
        ))}
        <div className={styles.total}>
          <span>Claimed</span>
          <span className={styles.lineAmount}>{formatINR(claimed)}</span>
        </div>
      </div>

      {claim.managerNote ? (
        <p className={styles.managerNote}>Manager: {claim.managerNote}</p>
      ) : null}

      {claim.attachmentCount === 0 ? <p className={styles.warning}>No receipt attached.</p> : null}

      <div className={styles.decision}>
        <FieldRow>
          <TextField
            label="Approve (₹)"
            type="number"
            min="0"
            step="0.01"
            value={approvedRupees}
            onChange={(event) => setApprovedRupees(event.target.value)}
            hint={reduced ? 'Less than claimed — say why in the note' : 'Full amount claimed'}
          />
          <TextField
            label="Note"
            optional
            value={note}
            maxLength={1000}
            placeholder={reduced ? 'Why the amount was reduced' : 'Shared with the employee'}
            onChange={(event) => setNote(event.target.value)}
          />
        </FieldRow>

        <div className={styles.decisionActions}>
          <Button
            variant="primary"
            busy={busy}
            disabled={reduced && note.trim().length === 0}
            onClick={() => onDecide({ approve: true, approvedRupees, note: note.trim() })}
          >
            Approve for payment
          </Button>
          <Button
            variant="danger"
            busy={busy}
            disabled={note.trim().length === 0}
            onClick={() => onDecide({ approve: false, note: note.trim() })}
          >
            Decline
          </Button>
        </div>
      </div>
    </Card>
  );
}

function NewBatchForm({
  cycles,
  onCreated,
}: {
  cycles: ReimbursementsResponse['cycles'];
  onCreated: () => Promise<unknown>;
}) {
  const toast = useToast();
  const [cycleId, setCycleId] = useState('');
  const [cutoffDate, setCutoffDate] = useState(toIsoDate(new Date()));
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ reference: string; claimCount: number }>(
        '/api/v1/payroll/reimbursements/batches',
        {
          ...(cycleId ? { payrollCycleId: cycleId } : {}),
          cutoffDate,
        },
      ),
    onSuccess: async (created) => {
      setError(null);
      toast.success(
        `${created.reference} created with ${created.claimCount} ${created.claimCount === 1 ? 'claim' : 'claims'}.`,
      );
      await onCreated();
    },
    onError: (failure: unknown) => {
      setError(failure instanceof ApiError ? failure.message : 'That batch could not be created.');
    },
  });

  return (
    <Card title="New batch" subtitle="Claims approved on or before the cut-off are included">
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <FieldRow>
          <SelectField
            label="Paying cycle"
            value={cycleId}
            onChange={(event) => setCycleId(event.target.value)}
            hint="A published cycle has already paid what it was going to"
          >
            <option value="">Not attached yet</option>
            {cycles.map((cycle) => (
              <option key={cycle.id} value={cycle.id}>
                {cycle.label} · pay {formatDate(cycle.payDate)}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Cut-off date"
            type="date"
            value={cutoffDate}
            onChange={(event) => setCutoffDate(event.target.value)}
          />
        </FieldRow>

        <FormError message={error} />

        <Button type="submit" variant="primary" busy={create.isPending}>
          Create batch
        </Button>
      </form>
    </Card>
  );
}
