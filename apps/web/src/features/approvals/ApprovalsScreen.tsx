import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatDateRange, formatDateTime, formatINR } from '@widedrop/shared';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { statusOf } from '../../lib/status.js';
import { Avatar } from '../../components/ui/Avatar.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow, Detail, DetailGrid } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { PageHeader, SplitLayout } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { TabPanel, Tabs } from '../../components/ui/Tabs.js';
import { useToast } from '../../components/ui/Toast.js';
import { useUiCopy } from '../../lib/uiCopy.js';
import { TextAreaField } from '../../components/form/Field.js';
import styles from './ApprovalsScreen.module.css';

interface ApprovalTask {
  id: string;
  kind: string;
  status: string;
  subjectType: string;
  subjectId: string;
  title: string;
  subtitle: string | null;
  amountMinor: string | null;
  requestedAt: string;
  decidedAt: string | null;
  employee: {
    id: string;
    fullName: string;
    initials: string;
    designation: string | null;
    department: string | null;
  };
  lastDecision: { outcome: string; note: string | null; at: string } | null;
}

interface ApprovalDetail {
  id: string;
  kind: string;
  status: string;
  title: string;
  subtitle: string | null;
  amountMinor: string | null;
  requestedAt: string;
  employee: { id: string; fullName: string; initials: string };
  detail:
    | {
        kind: 'leave';
        status: string;
        startDate: string;
        endDate: string;
        workingDays: number;
        reason: string | null;
        type: { name: string; code: string; isPaid: boolean };
        days: { date: string; portion: string }[];
        balances: {
          code: string;
          name: string;
          availableDays: number;
          entitlementDays: number;
        }[];
      }
    | {
        kind: 'expense';
        reference: string;
        title: string;
        status: string;
        totalAmountMinor: string;
        spendDate: string;
        lines: {
          id: string;
          description: string;
          spendDate: string;
          amountMinor: string;
          category: string;
        }[];
        attachments: { id: string; filename: string }[];
      }
    | null;
}

export function ApprovalsScreen() {
  const copy = useUiCopy();
  const [tab, setTab] = useState('pending');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const pending = useQuery({
    queryKey: queryKeys.approvals.pending,
    queryFn: () => api.get<{ items: ApprovalTask[] }>('/api/v1/approvals'),
  });

  const history = useQuery({
    queryKey: queryKeys.approvals.history,
    queryFn: () =>
      api.get<{ items: ApprovalTask[] }>('/api/v1/approvals', { query: { status: 'history' } }),
    enabled: tab === 'history',
  });

  const items = tab === 'pending' ? (pending.data?.items ?? []) : (history.data?.items ?? []);

  useEffect(() => {
    if (tab !== 'pending') return;
    const stillThere = items.some((item) => item.id === selectedId);
    if (!stillThere) setSelectedId(items[0]?.id ?? null);
  }, [items, selectedId, tab]);

  if (pending.error) {
    return <ErrorState error={pending.error} onRetry={() => void pending.refetch()} />;
  }

  const pendingCount = pending.data?.items.length ?? 0;

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Leave and expense requests from your team"
        actions={
          <Tabs
            label="Approval queue"
            active={tab}
            onChange={(id) => {
              setTab(id);
              setSelectedId(null);
            }}
            tabs={[
              { id: 'pending', label: 'Pending', count: pendingCount },
              { id: 'history', label: 'History' },
            ]}
          />
        }
      />

      <TabPanel id="pending" active={tab}>
        {pending.isPending ? (
          <Card>
            <SkeletonLines count={4} />
          </Card>
        ) : pendingCount === 0 ? (
          <EmptyState
            icon="approvals"
            title={copy('empty.approvals.title')}
            body={copy('empty.approvals.body')}
          />
        ) : (
          <SplitLayout>
            <Card flush>
              {items.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  selected={task.id === selectedId}
                  onSelect={() => setSelectedId(task.id)}
                />
              ))}
            </Card>

            {selectedId ? <DecisionPane taskId={selectedId} /> : null}
          </SplitLayout>
        )}
      </TabPanel>

      <TabPanel id="history" active={tab}>
        <Card flush>
          {history.isPending ? (
            <div className={styles.padded}>
              <SkeletonLines count={4} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              compact
              icon="approvals"
              title="Nothing decided yet"
              body="Requests you approve or decline appear here, with what you decided and when."
            />
          ) : (
            items.map((task) => {
              const status = statusOf(task.status);
              return (
                <DataRow
                  key={task.id}
                  leading={<Avatar initials={task.employee.initials} size={30} />}
                  title={task.title}
                  meta={[
                    task.subtitle,
                    task.decidedAt ? `decided ${formatDateTime(task.decidedAt)}` : null,
                    task.lastDecision?.note,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  value={task.amountMinor ? formatINR(Number(task.amountMinor)) : undefined}
                  trailing={<StatusChip label={status.label} tone={status.tone} />}
                />
              );
            })
          )}
        </Card>
      </TabPanel>
    </>
  );
}

function TaskRow({
  task,
  selected,
  onSelect,
}: {
  task: ApprovalTask;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DataRow
      leading={
        <Avatar initials={task.employee.initials} department={task.employee.department} size={32} />
      }
      title={task.title}
      meta={[task.subtitle, `asked ${formatDateTime(task.requestedAt)}`]
        .filter(Boolean)
        .join(' · ')}
      value={task.amountMinor ? formatINR(Number(task.amountMinor)) : undefined}
      selected={selected}
      onClick={onSelect}
    />
  );
}

function DecisionPane({ taskId }: { taskId: string }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');

  const task = useQuery({
    queryKey: ['approvals', 'detail', taskId],
    queryFn: () => api.get<ApprovalDetail>(`/api/v1/approvals/${taskId}`),
  });

  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') =>
      api.post(`/api/v1/approvals/${taskId}/decide`, {
        decision,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: async (_result, decision) => {
      setNote('');
      toast.success(decision === 'APPROVE' ? 'Approved.' : 'Declined.');
      await queryClient.invalidateQueries({ queryKey: ['approvals'] });
      await queryClient.invalidateQueries({ queryKey: queryKeys.badges });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'That decision could not be recorded.');
    },
  });

  if (task.error) return <ErrorState error={task.error} onRetry={() => void task.refetch()} />;
  if (task.isPending || !task.data) {
    return (
      <Card>
        <SkeletonLines count={6} />
      </Card>
    );
  }

  const data = task.data;
  const detail = data.detail;

  return (
    <Card
      title={data.title}
      subtitle={`Asked ${formatDateTime(data.requestedAt)}`}
      actions={<Avatar initials={data.employee.initials} name={data.employee.fullName} size={36} />}
    >
      {detail?.kind === 'leave' ? (
        <>
          <DetailGrid>
            <Detail label="Leave type" value={detail.type.name} />
            <Detail label="Dates" value={formatDateRange(detail.startDate, detail.endDate)} />
            <Detail
              label="Working days"
              value={`${detail.workingDays} ${detail.workingDays === 1 ? 'day' : 'days'}`}
            />
            <Detail label="Paid" value={detail.type.isPaid ? 'Yes' : 'No — loss of pay'} />
          </DetailGrid>

          {detail.reason ? <p className={styles.reason}>{detail.reason}</p> : null}

          {/* What the decision costs them, so nobody approves blind. */}
          {detail.balances.length > 0 ? (
            <div className={styles.balances}>
              <div className={styles.balancesHeading}>Their balances</div>
              {detail.balances.map((balance) => (
                <div key={balance.code} className={styles.balanceRow}>
                  <span>{balance.name}</span>
                  <span className={styles.balanceValue}>
                    {balance.availableDays} / {balance.entitlementDays} days
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : detail?.kind === 'expense' ? (
        <>
          <DetailGrid>
            <Detail label="Reference" value={detail.reference} />
            <Detail label="Spent" value={formatDate(detail.spendDate)} />
            <Detail label="Claimed" value={formatINR(Number(detail.totalAmountMinor))} />
            <Detail
              label="Receipts"
              value={
                detail.attachments.length > 0
                  ? `${detail.attachments.length} attached`
                  : 'none attached'
              }
            />
          </DetailGrid>

          <div className={styles.lines}>
            {detail.lines.map((line) => (
              <div key={line.id} className={styles.line}>
                <span>
                  <span className={styles.lineTitle}>{line.description}</span>
                  <span className={styles.lineMeta}>
                    {line.category} · {formatDate(line.spendDate)}
                  </span>
                </span>
                <span className={styles.lineAmount}>{formatINR(Number(line.amountMinor))}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          compact
          icon="approvals"
          title="Nothing to show"
          body="This request is decided on its own screen."
        />
      )}

      <div className={styles.decision}>
        <TextAreaField
          label="Note"
          optional
          rows={2}
          value={note}
          maxLength={1000}
          onChange={(event) => setNote(event.target.value)}
          hint="Required when declining, and shared with the person who asked"
        />
        <div className={styles.decisionActions}>
          <Button
            variant="primary"
            busy={decide.isPending && decide.variables === 'APPROVE'}
            onClick={() => decide.mutate('APPROVE')}
          >
            Approve
          </Button>
          <Button
            variant="danger"
            busy={decide.isPending && decide.variables === 'REJECT'}
            disabled={note.trim().length === 0}
            onClick={() => decide.mutate('REJECT')}
          >
            Decline
          </Button>
        </div>
      </div>
    </Card>
  );
}
