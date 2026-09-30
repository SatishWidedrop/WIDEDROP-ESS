import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatDateTime } from '@widedrop/shared';
import { api } from '../../lib/api.js';
import { statusOf } from '../../lib/status.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow, Meter } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { PageHeader, SplitLayout } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { useToast } from '../../components/ui/Toast.js';
import styles from './HrScreens.module.css';

interface PolicyAdminResponse {
  items: {
    id: string;
    code: string;
    name: string;
    ownerTeam: string;
    contactEmail: string | null;
    status: string;
    versions: {
      id: string;
      versionLabel: string;
      versionNumber: number;
      status: string;
      summary: string;
      effectiveFrom: string;
      publishedAt: string | null;
      requiresAcknowledgement: boolean;
      assignedCount: number;
      acknowledgedCount: number;
      pendingCount: number;
      overdueCount: number;
      canPublish: boolean;
    }[];
  }[];
}

export function PolicyAdminScreen() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  const policies = useQuery({
    queryKey: ['hr', 'policies'],
    queryFn: () => api.get<PolicyAdminResponse>('/api/v1/hr/policies'),
  });

  const acknowledgements = useQuery({
    queryKey: ['hr', 'policies', 'acknowledgements', selectedVersionId],
    queryFn: () =>
      api.get<{
        items: {
          id: string;
          status: string;
          acknowledgedAt: string | null;
          dueOn: string | null;
          employee: { id: string; fullName: string; initials: string; employeeNumber: string };
        }[];
      }>(`/api/v1/hr/policies/versions/${selectedVersionId}/acknowledgements`),
    enabled: selectedVersionId !== null,
  });

  const publish = useMutation({
    mutationFn: (versionId: string) =>
      api.post<{ assigned: number; supersededVersionId: string | null }>(
        `/api/v1/hr/policies/versions/${versionId}/publish`,
        {},
      ),
    onSuccess: async (result) => {
      toast.success(
        `Published to ${result.assigned} ${result.assigned === 1 ? 'person' : 'people'}${
          result.supersededVersionId ? ', superseding the previous version' : ''
        }.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['hr', 'policies'] });
      await queryClient.invalidateQueries({ queryKey: ['policies'] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'That version could not be published.');
    },
  });

  if (policies.error) {
    return <ErrorState error={policies.error} onRetry={() => void policies.refetch()} />;
  }

  const items = policies.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Policy admin"
        subtitle="Publishing a version resolves who it applies to into rows, so every count here is a count of real acknowledgements"
      />

      {policies.isPending ? (
        <Card>
          <SkeletonLines count={5} />
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon="policies"
          title="No policies yet"
          body="A policy holds versions; a version is never edited once published, so a change publishes a new one and supersedes the old."
        />
      ) : (
        <SplitLayout>
          <Card flush>
            <div className={styles.versions}>
              {items.map((policy) => (
                <div key={policy.id} className={styles.policyGroup}>
                  <div className={styles.policyName}>
                    <span className={styles.policyTitle}>{policy.name}</span>
                    <StatusChip {...statusOf(policy.status)} />
                    <span className={styles.policyOwner}>{policy.ownerTeam}</span>
                  </div>

                  {policy.versions.length === 0 ? (
                    <p className={styles.note}>No versions drafted.</p>
                  ) : (
                    policy.versions.map((version) => (
                      <button
                        key={version.id}
                        type="button"
                        className={styles.version}
                        onClick={() => setSelectedVersionId(version.id)}
                      >
                        <StatusChip {...statusOf(version.status)} />
                        <span>{version.versionLabel}</span>
                        <span>effective {formatDate(version.effectiveFrom)}</span>

                        {version.requiresAcknowledgement && version.assignedCount > 0 ? (
                          <span className={styles.progress}>
                            <span className={styles.meterWrap}>
                              <Meter
                                value={version.acknowledgedCount}
                                max={version.assignedCount}
                                label={`${version.acknowledgedCount} of ${version.assignedCount} acknowledged`}
                                tone={version.overdueCount > 0 ? 'amber' : 'green'}
                              />
                            </span>
                            <span className={styles.progressText}>
                              {version.acknowledgedCount}/{version.assignedCount}
                            </span>
                          </span>
                        ) : null}

                        {version.canPublish ? (
                          <Button
                            size="small"
                            variant="primary"
                            busy={publish.isPending && publish.variables === version.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              publish.mutate(version.id);
                            }}
                          >
                            Publish
                          </Button>
                        ) : null}
                      </button>
                    ))
                  )}
                </div>
              ))}
            </div>
          </Card>

          {selectedVersionId === null ? (
            <Card>
              <EmptyState
                icon="policies"
                title="No version selected"
                body="Choose a version to see who has acknowledged it and who has not."
              />
            </Card>
          ) : (
            <Card title="Acknowledgements" flush>
              {acknowledgements.isPending ? (
                <div className={styles.padded}>
                  <SkeletonLines count={5} />
                </div>
              ) : (acknowledgements.data?.items.length ?? 0) === 0 ? (
                <EmptyState
                  compact
                  icon="policies"
                  title="Not assigned to anyone"
                  body="Assignments are created at publication from the version's applicability rules."
                />
              ) : (
                acknowledgements.data?.items.map((row) => (
                  <DataRow
                    key={row.id}
                    title={row.employee.fullName}
                    meta={[
                      row.employee.employeeNumber,
                      row.acknowledgedAt
                        ? `acknowledged ${formatDateTime(row.acknowledgedAt)}`
                        : row.dueOn
                          ? `due ${formatDate(row.dueOn)}`
                          : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    trailing={<StatusChip {...statusOf(row.status)} />}
                  />
                ))
              )}
            </Card>
          )}
        </SplitLayout>
      )}
    </>
  );
}
