import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatDateTime } from '@widedrop/shared';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { statusOf } from '../../lib/status.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow, Detail, DetailGrid } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { PageHeader, SplitLayout } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { useToast } from '../../components/ui/Toast.js';
import styles from './PoliciesScreen.module.css';

interface PolicyListItem {
  policyId: string;
  code: string;
  name: string;
  ownerTeam: string;
  contactEmail: string | null;
  versionId: string;
  versionLabel: string;
  versionStatus: string;
  summary: string;
  effectiveFrom: string;
  points: { id: string; text: string }[];
  hasDocument: boolean;
  requiresAcknowledgement: boolean;
  acknowledgementStatus: string | null;
  acknowledgedAt: string | null;
  dueOn: string | null;
  canAcknowledge: boolean;
}

interface PolicyDetail {
  id: string;
  versionLabel: string;
  status: string;
  summary: string;
  body: string;
  effectiveFrom: string;
  publishedAt: string | null;
  supersededBy: { id: string; versionLabel: string } | null;
  requiresAcknowledgement: boolean;
  hasDocument: boolean;
  policy: { id: string; name: string; ownerTeam: string; contactEmail: string | null };
  points: { id: string; text: string }[];
  acknowledgement: { status: string; acknowledgedAt: string | null; dueOn: string | null } | null;
}

export function PoliciesScreen() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('policy'));

  const list = useQuery({
    queryKey: queryKeys.policies.list,
    queryFn: () => api.get<{ items: PolicyListItem[]; pendingCount: number }>('/api/v1/policies'),
  });

  // Open what needs doing first. A policies screen whose detail pane is empty
  // beside a list of pending acknowledgements wastes the click.
  useEffect(() => {
    if (selectedId || !list.data) return;
    const first = list.data.items.find((item) => item.canAcknowledge) ?? list.data.items[0];
    if (first) setSelectedId(first.versionId);
  }, [list.data, selectedId]);

  const detail = useQuery({
    queryKey: queryKeys.policies.detail(selectedId ?? ''),
    queryFn: () => api.get<PolicyDetail>(`/api/v1/policies/${selectedId}`),
    enabled: selectedId !== null,
  });

  const acknowledge = useMutation({
    mutationFn: (versionId: string) =>
      api.post<{ acknowledgedAt: string }>(`/api/v1/policies/${versionId}/acknowledge`, {
        policyVersionId: versionId,
      }),
    onSuccess: async () => {
      toast.success('Acknowledgement recorded.');
      await queryClient.invalidateQueries({ queryKey: ['policies'] });
      await queryClient.invalidateQueries({ queryKey: queryKeys.badges });
      await queryClient.invalidateQueries({ queryKey: queryKeys.home });
    },
    onError: (error: unknown) => {
      toast.error(
        error instanceof Error ? error.message : 'That acknowledgement could not be recorded.',
      );
    },
  });

  async function download(versionId: string) {
    try {
      const { url } = await api.get<{ url: string }>(`/api/v1/policies/${versionId}/document`);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That document could not be opened.');
    }
  }

  if (list.error) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;

  const items = list.data?.items ?? [];
  const pending = list.data?.pendingCount ?? 0;

  return (
    <>
      <PageHeader
        title="Policies"
        subtitle="Company policies and your acknowledgements"
        badge={
          pending > 0 ? (
            <StatusChip
              label={`${pending} awaiting acknowledgement`}
              tone="amber"
              showDot={false}
            />
          ) : null
        }
      />

      {list.isPending ? (
        <Card>
          <SkeletonLines count={5} />
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon="policies"
          title="No policies apply to you yet"
          body="People Ops assigns policies when they are published. Any that need your acknowledgement will appear here and on your home screen."
        />
      ) : (
        <SplitLayout>
          <Card flush>
            {items.map((item) => {
              const status = statusOf(item.acknowledgementStatus ?? item.versionStatus);
              return (
                <DataRow
                  key={item.versionId}
                  title={item.name}
                  meta={`${item.versionLabel} · ${item.ownerTeam}`}
                  selected={item.versionId === selectedId}
                  onClick={() => {
                    setSelectedId(item.versionId);
                    setSearchParams({ policy: item.versionId }, { replace: true });
                  }}
                  trailing={<StatusChip label={status.label} tone={status.tone} />}
                />
              );
            })}
          </Card>

          {detail.error ? (
            <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
          ) : detail.isPending || !detail.data ? (
            <Card>
              <SkeletonLines count={8} />
            </Card>
          ) : (
            <PolicyDetailView
              policy={detail.data}
              busy={acknowledge.isPending}
              onAcknowledge={() => acknowledge.mutate(detail.data.id)}
              onDownload={() => void download(detail.data.id)}
            />
          )}
        </SplitLayout>
      )}
    </>
  );
}

function PolicyDetailView({
  policy,
  busy,
  onAcknowledge,
  onDownload,
}: {
  policy: PolicyDetail;
  busy: boolean;
  onAcknowledge: () => void;
  onDownload: () => void;
}) {
  const acknowledged = policy.acknowledgement?.status === 'ACKNOWLEDGED';
  const canAcknowledge =
    policy.status === 'PUBLISHED' &&
    policy.requiresAcknowledgement &&
    (policy.acknowledgement?.status === 'PENDING' || policy.acknowledgement?.status === 'OVERDUE');

  return (
    <Card>
      <div className={styles.eyebrow}>
        {policy.policy.ownerTeam} · {policy.versionLabel}
        {policy.publishedAt ? ` · Published ${formatDate(policy.publishedAt.slice(0, 10))}` : ''}
      </div>
      <h2 className={styles.name}>{policy.policy.name}</h2>
      <p className={styles.summary}>{policy.summary}</p>

      {/* A version that has been replaced says so, at the top, before anyone
          reads a rule that no longer applies. */}
      {policy.supersededBy ? (
        <p className={styles.superseded}>
          This version has been replaced by {policy.supersededBy.versionLabel}. It is kept because
          your acknowledgement refers to it.
        </p>
      ) : null}

      <DetailGrid>
        <Detail label="Effective from" value={formatDate(policy.effectiveFrom)} />
        <Detail label="Version" value={policy.versionLabel} />
        <Detail
          label="Acknowledgement"
          value={
            acknowledged && policy.acknowledgement?.acknowledgedAt
              ? formatDateTime(policy.acknowledgement.acknowledgedAt)
              : policy.acknowledgement?.dueOn
                ? `Due ${formatDate(policy.acknowledgement.dueOn)}`
                : policy.requiresAcknowledgement
                  ? 'Required'
                  : 'Not required'
          }
        />
        <Detail label="Questions" value={policy.policy.contactEmail} />
      </DetailGrid>

      {policy.points.length > 0 ? (
        <div className={styles.points}>
          <div className={styles.pointsHeading}>What this policy covers</div>
          <ul className={styles.pointList}>
            {policy.points.map((point) => (
              <li key={point.id} className={styles.point}>
                {point.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/*
        The policy text. Rendered as plain paragraphs rather than as markup:
        the content strategy allows rich text, but nothing in this build sets
        HTML from the server, which is what keeps the strict CSP honest.
      */}
      <div className={styles.body}>
        {policy.body
          .split(/\n{2,}/)
          .filter((paragraph) => paragraph.trim().length > 0)
          .map((paragraph, index) => (
            <p key={index} className={styles.paragraph}>
              {paragraph.trim()}
            </p>
          ))}
      </div>

      <div className={styles.footer}>
        {canAcknowledge ? (
          <>
            <Button variant="primary" busy={busy} onClick={onAcknowledge}>
              I have read and acknowledge
            </Button>
            {policy.acknowledgement?.dueOn ? (
              <span className={styles.due}>Due {formatDate(policy.acknowledgement.dueOn)}</span>
            ) : null}
          </>
        ) : acknowledged && policy.acknowledgement?.acknowledgedAt ? (
          <span className={styles.acknowledged}>
            Acknowledged on {formatDateTime(policy.acknowledgement.acknowledgedAt)}
          </span>
        ) : null}

        {policy.hasDocument ? (
          <Button variant="secondary" icon="download" onClick={onDownload}>
            Download PDF
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
