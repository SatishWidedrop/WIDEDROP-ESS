import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate } from '@widedrop/shared';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { useUiCopy } from '../../lib/uiCopy.js';
import { Card } from '../../components/ui/Card.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { PageHeader, SplitLayout } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import styles from './AnnouncementsScreen.module.css';

interface AnnouncementSummary {
  id: string;
  title: string;
  department: string;
  byline: string | null;
  isPinned: boolean;
  publishedAt: string | null;
  excerpt: string | null;
  readAt: string | null;
}

interface AnnouncementDetail {
  id: string;
  title: string;
  department: string;
  byline: string | null;
  isPinned: boolean;
  publishedAt: string | null;
  paragraphs: { id: string; text: string }[];
}

export function AnnouncementsScreen() {
  const copy = useUiCopy();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('announcement'));

  const list = useQuery({
    queryKey: queryKeys.announcements.list,
    queryFn: () =>
      api.get<{ items: AnnouncementSummary[]; unreadCount: number }>('/api/v1/announcements'),
  });

  useEffect(() => {
    if (!selectedId && list.data?.items[0]) setSelectedId(list.data.items[0].id);
  }, [list.data, selectedId]);

  const detail = useQuery({
    queryKey: queryKeys.announcements.detail(selectedId ?? ''),
    queryFn: () => api.get<AnnouncementDetail>(`/api/v1/announcements/${selectedId}`),
    enabled: selectedId !== null,
  });

  // Opening one marks it read on the server; the list's unread marks follow.
  useEffect(() => {
    if (detail.data) void queryClient.invalidateQueries({ queryKey: queryKeys.announcements.list });
  }, [detail.data, queryClient]);

  if (list.error) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;

  const items = list.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Announcements"
        subtitle="Updates from People Ops, Finance, IT and Leadership"
        badge={
          (list.data?.unreadCount ?? 0) > 0 ? (
            <StatusChip label={`${list.data!.unreadCount} unread`} tone="blue" showDot={false} />
          ) : null
        }
      />

      {list.isPending ? (
        <Card>
          <SkeletonLines count={5} />
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon="announcements"
          title={copy('empty.announcements.title')}
          body={copy('empty.announcements.body')}
        />
      ) : (
        <SplitLayout>
          <Card flush>
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`${styles.row} ${item.id === selectedId ? styles.rowSelected : ''}`}
                onClick={() => {
                  setSelectedId(item.id);
                  setSearchParams({ announcement: item.id }, { replace: true });
                }}
                aria-current={item.id === selectedId ? 'true' : undefined}
              >
                <span className={styles.rowMeta}>
                  {item.isPinned ? <span className={styles.pin}>Pinned</span> : null}
                  {/* Unread is a row that does not exist, not a guess. */}
                  {item.readAt === null ? (
                    <span className={styles.unread} aria-label="Unread" />
                  ) : null}
                  <span>
                    {item.department}
                    {item.publishedAt ? ` · ${formatDate(item.publishedAt.slice(0, 10))}` : ''}
                  </span>
                </span>
                <span className={styles.rowTitle}>{item.title}</span>
              </button>
            ))}
          </Card>

          {detail.error ? (
            <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
          ) : detail.isPending || !detail.data ? (
            <Card>
              <SkeletonLines count={6} />
            </Card>
          ) : (
            <Card>
              <div className={styles.eyebrow}>
                {detail.data.department}
                {detail.data.publishedAt
                  ? ` · ${formatDate(detail.data.publishedAt.slice(0, 10))}`
                  : ''}
              </div>
              <h2 className={styles.title}>{detail.data.title}</h2>
              <div className={styles.body}>
                {detail.data.paragraphs.map((paragraph) => (
                  <p key={paragraph.id} className={styles.paragraph}>
                    {paragraph.text}
                  </p>
                ))}
              </div>
              {detail.data.byline ? (
                <p className={styles.byline}>Posted by {detail.data.byline}</p>
              ) : null}
            </Card>
          )}
        </SplitLayout>
      )}
    </>
  );
}
