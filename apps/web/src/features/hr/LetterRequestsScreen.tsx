import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '@widedrop/shared';
import { api } from '../../lib/api.js';
import { statusOf } from '../../lib/status.js';
import { Avatar } from '../../components/ui/Avatar.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { PageHeader, SplitLayout } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { useToast } from '../../components/ui/Toast.js';
import { TextAreaField } from '../../components/form/Field.js';
import styles from './HrScreens.module.css';

interface LetterRequest {
  id: string;
  status: string;
  typeName: string;
  addressee: string | null;
  purpose: string | null;
  requestedAt: string;
  startedAt: string | null;
  issuedAt: string | null;
  rejectionReason: string | null;
  hasDocument: boolean;
  employee: { id: string; fullName: string; initials: string; employeeNumber: string };
  template: { id: string; name: string; version: number } | null;
}

export function LetterRequestsScreen() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const requests = useQuery({
    queryKey: ['hr', 'documents', 'requests'],
    queryFn: () => api.get<{ items: LetterRequest[] }>('/api/v1/hr/documents/requests'),
  });

  const preview = useQuery({
    queryKey: ['hr', 'documents', 'preview', selectedId],
    queryFn: () =>
      api.get<{ body: string | null; missing: string[]; reason: string | null }>(
        `/api/v1/hr/documents/requests/${selectedId}/preview`,
      ),
    enabled: selectedId !== null,
    retry: false,
  });

  const transition = useMutation({
    mutationFn: (input: { id: string; event: string; rejectionReason?: string }) =>
      api.post<{ status: string }>(`/api/v1/hr/documents/requests/${input.id}/transition`, {
        event: input.event,
        ...(input.rejectionReason ? { rejectionReason: input.rejectionReason } : {}),
      }),
    onSuccess: async (result) => {
      setReason('');
      toast.success(`Moved to ${statusOf(result.status).label.toLowerCase()}.`);
      await queryClient.invalidateQueries({ queryKey: ['hr', 'documents'] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'That step could not be taken.');
    },
  });

  if (requests.error) {
    return <ErrorState error={requests.error} onRetry={() => void requests.refetch()} />;
  }

  const items = requests.data?.items ?? [];
  const selected = items.find((request) => request.id === selectedId) ?? null;

  return (
    <>
      <PageHeader
        title="Letter requests"
        subtitle="Letters are generated from persisted employee data; a placeholder the database cannot fill is named rather than left blank"
      />

      {requests.isPending ? (
        <Card>
          <SkeletonLines count={4} />
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon="documents"
          title="No letter requests"
          body="An employee asking for an employment letter or a salary certificate appears here."
        />
      ) : (
        <SplitLayout>
          <Card flush>
            {items.map((request) => (
              <DataRow
                key={request.id}
                leading={<Avatar initials={request.employee.initials} size={30} />}
                title={request.typeName}
                meta={`${request.employee.fullName} · asked ${formatDateTime(request.requestedAt)}`}
                selected={request.id === selectedId}
                onClick={() => setSelectedId(request.id)}
                trailing={<StatusChip {...statusOf(request.status)} />}
              />
            ))}
          </Card>

          {selected === null ? (
            <Card>
              <EmptyState
                icon="documents"
                title="Nothing selected"
                body="Choose a request to preview the letter and issue it."
              />
            </Card>
          ) : (
            <Card
              title={selected.typeName}
              subtitle={`${selected.employee.fullName} (${selected.employee.employeeNumber})${selected.addressee ? ` · for ${selected.addressee}` : ''}`}
              actions={<StatusChip {...statusOf(selected.status)} />}
            >
              {selected.purpose ? <p className={styles.note}>{selected.purpose}</p> : null}

              {preview.data?.reason ? (
                <p className={styles.missing}>{preview.data.reason}</p>
              ) : preview.data?.missing.length ? (
                <p className={styles.missing}>
                  The template asks for {preview.data.missing.join(', ')}, which the database does
                  not hold for this employee. Fill those in before issuing.
                </p>
              ) : null}

              {preview.data?.body ? (
                <div className={styles.preview}>{preview.data.body}</div>
              ) : null}

              <div className={styles.form} style={{ marginTop: 'var(--space-9)' }}>
                <TextAreaField
                  label="Reason"
                  optional
                  rows={2}
                  value={reason}
                  maxLength={1000}
                  hint="Required when declining, and shown to the employee"
                  onChange={(event) => setReason(event.target.value)}
                />

                <div className={styles.filters}>
                  {selected.status === 'SUBMITTED' ? (
                    <Button
                      variant="secondary"
                      busy={transition.isPending}
                      onClick={() => transition.mutate({ id: selected.id, event: 'REVIEW' })}
                    >
                      Start review
                    </Button>
                  ) : null}
                  {selected.status === 'IN_REVIEW' ? (
                    <Button
                      variant="secondary"
                      busy={transition.isPending}
                      onClick={() => transition.mutate({ id: selected.id, event: 'START' })}
                    >
                      Start preparing
                    </Button>
                  ) : null}
                  {['SUBMITTED', 'IN_REVIEW', 'PROCESSING'].includes(selected.status) ? (
                    <Button
                      variant="danger"
                      disabled={reason.trim().length === 0}
                      busy={transition.isPending}
                      onClick={() =>
                        transition.mutate({
                          id: selected.id,
                          event: 'REJECT',
                          rejectionReason: reason.trim(),
                        })
                      }
                    >
                      Decline
                    </Button>
                  ) : null}
                </div>

                {/*
                  Issuing needs the rendered document, which the letter
                  service produces outside this screen. Said plainly rather
                  than offering a button that would be refused.
                */}
                {selected.status === 'PROCESSING' ? (
                  <p className={styles.note}>
                    Issuing attaches the signed PDF. Upload it through the document service, which
                    records the file against this request and notifies the employee.
                  </p>
                ) : null}
              </div>
            </Card>
          )}
        </SplitLayout>
      )}
    </>
  );
}
