import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate } from '@widedrop/shared';
import { ApiError, api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { statusOf } from '../../lib/status.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { Icon } from '../../components/ui/Icon.js';
import { PageHeader, SplitLayout, Stack } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { useToast } from '../../components/ui/Toast.js';
import { FormError, SelectField, TextAreaField, TextField } from '../../components/form/Field.js';
import styles from './DocumentsScreen.module.css';

interface DocumentsResponse {
  documents: {
    id: string;
    title: string;
    documentDate: string;
    uploadedAt: string;
    type: { id: string; name: string; category: string };
    filename: string;
    sizeBytes: number;
    contentType: string;
  }[];
  requests: {
    id: string;
    status: string;
    typeName: string;
    typeId: string;
    addressee: string | null;
    purpose: string | null;
    requestedAt: string;
    issuedAt: string | null;
    rejectionReason: string | null;
    hasDocument: boolean;
    canCancel: boolean;
  }[];
  requestableTypes: { id: string; code: string; name: string; category: string }[];
}

export function DocumentsScreen() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: queryKeys.documents.list,
    queryFn: () => api.get<DocumentsResponse>('/api/v1/documents'),
  });

  async function download(path: string) {
    try {
      const { url } = await api.get<{ url: string }>(path);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That document could not be opened.');
    }
  }

  async function cancel(id: string) {
    try {
      await api.post(`/api/v1/documents/requests/${id}/cancel`, {});
      toast.success('Request cancelled.');
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That could not be cancelled.');
    }
  }

  if (list.error) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;

  const data = list.data;

  return (
    <>
      <PageHeader title="Documents" subtitle="Letters, certificates and your HR records" />

      <SplitLayout variant="form">
        <RequestLetterForm
          types={data?.requestableTypes ?? []}
          loading={list.isPending}
          onRequested={async () => {
            await queryClient.invalidateQueries({ queryKey: ['documents'] });
          }}
        />

        <Stack>
          <Card title="Letter requests" flush>
            {list.isPending ? (
              <div className={styles.padded}>
                <SkeletonLines count={2} />
              </div>
            ) : (data?.requests.length ?? 0) === 0 ? (
              <EmptyState
                compact
                icon="documents"
                title="No letters requested"
                body="A letter you ask for appears here while People Ops prepares it."
              />
            ) : (
              data?.requests.map((request) => {
                const status = statusOf(request.status);
                return (
                  <DataRow
                    key={request.id}
                    title={request.typeName}
                    meta={[
                      `Requested ${formatDate(request.requestedAt.slice(0, 10))}`,
                      request.addressee ? `for ${request.addressee}` : null,
                      request.rejectionReason,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    trailing={
                      <>
                        <StatusChip label={status.label} tone={status.tone} />
                        {/* Offered only when a file exists: a download button
                            that fails is worse than none. */}
                        {request.hasDocument ? (
                          <Button
                            size="small"
                            variant="ghost"
                            icon="download"
                            aria-label={`Download ${request.typeName}`}
                            onClick={() =>
                              void download(`/api/v1/documents/requests/${request.id}/download`)
                            }
                          />
                        ) : null}
                        {request.canCancel ? (
                          <Button
                            size="small"
                            variant="ghost"
                            onClick={() => void cancel(request.id)}
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </>
                    }
                  />
                );
              })
            )}
          </Card>

          <Card title="My documents" subtitle="Issued by Widedrop" flush>
            {list.isPending ? (
              <div className={styles.padded}>
                <SkeletonLines count={3} />
              </div>
            ) : (data?.documents.length ?? 0) === 0 ? (
              <EmptyState
                compact
                icon="documents"
                title="No documents yet"
                body="Offer letters, appraisal letters and certificates People Ops issues appear here."
              />
            ) : (
              data?.documents.map((document) => (
                <DataRow
                  key={document.id}
                  leading={<Icon name="documents" size={18} className={styles.glyph} />}
                  title={document.title}
                  meta={`${document.type.name} · ${formatDate(document.documentDate)} · ${formatSize(document.sizeBytes)}`}
                  trailing={
                    <Button
                      size="small"
                      variant="ghost"
                      icon="download"
                      aria-label={`Download ${document.title}`}
                      onClick={() => void download(`/api/v1/documents/${document.id}/download`)}
                    />
                  }
                />
              ))
            )}
          </Card>
        </Stack>
      </SplitLayout>
    </>
  );
}

function RequestLetterForm({
  types,
  loading,
  onRequested,
}: {
  types: DocumentsResponse['requestableTypes'];
  loading: boolean;
  onRequested: () => Promise<void>;
}) {
  const toast = useToast();
  const [typeId, setTypeId] = useState('');
  const [addressee, setAddressee] = useState('');
  const [purpose, setPurpose] = useState('');
  const [error, setError] = useState<string | null>(null);

  const request = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/api/v1/documents/requests', {
        documentTypeId: typeId || types[0]?.id,
        ...(addressee.trim() ? { addressee: addressee.trim() } : {}),
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
      }),
    onSuccess: async () => {
      setError(null);
      setAddressee('');
      setPurpose('');
      toast.success('Requested. People Ops will prepare it.');
      await onRequested();
    },
    onError: (failure: unknown) => {
      setError(
        failure instanceof ApiError
          ? failure.message
          : 'That request could not be sent. Try again.',
      );
    },
  });

  if (loading) {
    return (
      <Card title="Request a letter">
        <SkeletonLines count={3} />
      </Card>
    );
  }

  if (types.length === 0) {
    return (
      <Card title="Request a letter">
        <EmptyState
          compact
          icon="documents"
          title="No letters available to request"
          body="People Ops publishes the letter types employees may ask for."
        />
      </Card>
    );
  }

  return (
    <Card title="Request a letter">
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          request.mutate();
        }}
      >
        <SelectField
          label="Letter type"
          value={typeId || types[0]?.id}
          onChange={(event) => setTypeId(event.target.value)}
        >
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </SelectField>

        <TextField
          label="Addressed to"
          optional
          value={addressee}
          maxLength={160}
          placeholder="e.g. HDFC Bank, Koramangala branch"
          onChange={(event) => setAddressee(event.target.value)}
        />

        <TextAreaField
          label="Purpose"
          optional
          rows={2}
          value={purpose}
          maxLength={500}
          onChange={(event) => setPurpose(event.target.value)}
        />

        <FormError message={error} />

        <Button type="submit" variant="primary" busy={request.isPending}>
          Request letter
        </Button>
      </form>
    </Card>
  );
}

/** A size a person can read, from the stored byte count. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
