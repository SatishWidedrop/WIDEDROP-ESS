import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '@widedrop/shared';
import { api } from '../../lib/api.js';
import { statusOf } from '../../lib/status.js';
import { Avatar } from '../../components/ui/Avatar.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow, Reference } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { PageHeader, SplitLayout } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { useToast } from '../../components/ui/Toast.js';
import { TextAreaField } from '../../components/form/Field.js';
import styles from './HrScreens.module.css';

interface QueueTicket {
  id: string;
  reference: string;
  subject: string;
  status: string;
  priority: string;
  category: string;
  requester: { id: string; fullName: string; initials: string; employeeNumber: string };
  assignee: { id: string; fullName: string; initials: string } | null;
  createdAt: string;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  firstResponseBreached: boolean;
  resolutionBreached: boolean;
}

interface TicketDetail {
  id: string;
  reference: string;
  subject: string;
  description: string;
  status: string;
  category: { id: string; name: string };
  requester: { id: string; fullName: string; initials: string; employeeNumber: string };
  comments: {
    id: string;
    body: string;
    visibility: string;
    createdAt: string;
    author: { id: string; fullName: string; initials: string } | null;
  }[];
}

export function TicketQueueScreen() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);

  const queue = useQuery({
    queryKey: ['hr', 'tickets'],
    queryFn: () =>
      api.get<{ items: QueueTicket[] }>('/api/v1/hr/tickets', { query: { status: 'open' } }),
  });

  const ticket = useQuery({
    queryKey: ['hr', 'tickets', selectedId],
    queryFn: () => api.get<TicketDetail>(`/api/v1/help/tickets/${selectedId}`),
    enabled: selectedId !== null,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['hr', 'tickets'] });
    await queryClient.invalidateQueries({ queryKey: queryKeys });
  };

  const comment = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/help/tickets/${selectedId}/comments`, { body: reply.trim(), internal }),
    onSuccess: async () => {
      setReply('');
      toast.success(internal ? 'Internal note added.' : 'Reply sent.');
      await refresh();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'That could not be posted.');
    },
  });

  const transition = useMutation({
    mutationFn: (event: string) =>
      api.post<{ status: string }>(`/api/v1/help/tickets/${selectedId}/transition`, { event }),
    onSuccess: async (result) => {
      toast.success(`Moved to ${statusOf(result.status).label.toLowerCase()}.`);
      await refresh();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'That step could not be taken.');
    },
  });

  if (queue.error) return <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />;

  const items = queue.data?.items ?? [];
  const breached = items.filter(
    (row) => row.firstResponseBreached || row.resolutionBreached,
  ).length;

  return (
    <>
      <PageHeader
        title="Help desk queue"
        subtitle={`${items.length} open · SLA breaches are computed from the stored due time and the time paused`}
        badge={
          breached > 0 ? (
            <StatusChip label={`${breached} past due`} tone="red" showDot={false} />
          ) : null
        }
      />

      {queue.isPending ? (
        <Card>
          <SkeletonLines count={5} />
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon="help"
          title="Nothing open"
          body="Tickets employees raise appear here, newest first within each priority."
        />
      ) : (
        <SplitLayout>
          <Card flush>
            {items.map((row) => (
              <DataRow
                key={row.id}
                leading={<Reference>{row.reference}</Reference>}
                title={row.subject}
                meta={`${row.requester.fullName} · ${row.category} · ${formatDateTime(row.createdAt)}`}
                selected={row.id === selectedId}
                onClick={() => setSelectedId(row.id)}
                trailing={
                  <>
                    {row.firstResponseBreached ? (
                      <StatusChip label="No reply" tone="red" />
                    ) : row.resolutionBreached ? (
                      <StatusChip label="Past due" tone="red" />
                    ) : null}
                    <StatusChip {...statusOf(row.status)} />
                  </>
                }
              />
            ))}
          </Card>

          {selectedId === null ? (
            <Card>
              <EmptyState
                icon="help"
                title="Nothing selected"
                body="Choose a ticket to read it and reply."
              />
            </Card>
          ) : ticket.isPending || !ticket.data ? (
            <Card>
              <SkeletonLines count={6} />
            </Card>
          ) : (
            <Card
              title={ticket.data.subject}
              subtitle={`${ticket.data.reference} · ${ticket.data.category.name} · ${ticket.data.requester.fullName}`}
              actions={<StatusChip {...statusOf(ticket.data.status)} />}
            >
              <p className={styles.note}>{ticket.data.description}</p>

              {ticket.data.comments.length > 0 ? (
                <div className={styles.paragraphs} style={{ marginTop: 'var(--space-9)' }}>
                  {ticket.data.comments.map((entry) => (
                    <div key={entry.id}>
                      <div className={styles.policyName}>
                        <Avatar initials={entry.author?.initials ?? 'WD'} size={24} />
                        <span className={styles.policyTitle}>
                          {entry.author?.fullName ?? 'Widedrop'}
                        </span>
                        {entry.visibility === 'INTERNAL' ? (
                          <StatusChip label="Internal" tone="gray" showDot={false} />
                        ) : null}
                        <span className={styles.policyOwner}>
                          {formatDateTime(entry.createdAt)}
                        </span>
                      </div>
                      <p className={styles.note}>{entry.body}</p>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className={styles.form} style={{ marginTop: 'var(--space-9)' }}>
                <TextAreaField
                  label="Reply"
                  rows={4}
                  value={reply}
                  maxLength={5000}
                  onChange={(event) => setReply(event.target.value)}
                />

                <label className={styles.note}>
                  <input
                    type="checkbox"
                    checked={internal}
                    onChange={(event) => setInternal(event.target.checked)}
                  />{' '}
                  Internal note — never shown to the requester
                </label>

                <div className={styles.filters}>
                  <Button
                    variant="primary"
                    busy={comment.isPending}
                    disabled={reply.trim().length === 0}
                    onClick={() => comment.mutate()}
                  >
                    {internal ? 'Add note' : 'Send reply'}
                  </Button>

                  {ticket.data.status === 'OPEN' || ticket.data.status === 'REOPENED' ? (
                    <Button
                      variant="secondary"
                      busy={transition.isPending}
                      onClick={() => transition.mutate('START')}
                    >
                      Start work
                    </Button>
                  ) : null}
                  {ticket.data.status === 'IN_PROGRESS' ? (
                    <>
                      <Button
                        variant="secondary"
                        busy={transition.isPending}
                        onClick={() => transition.mutate('REQUEST_INFO')}
                      >
                        Ask for detail
                      </Button>
                      <Button
                        variant="primary"
                        busy={transition.isPending}
                        onClick={() => transition.mutate('RESOLVE')}
                      >
                        Resolve
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            </Card>
          )}
        </SplitLayout>
      )}
    </>
  );
}

const queryKeys = ['help'] as const;
