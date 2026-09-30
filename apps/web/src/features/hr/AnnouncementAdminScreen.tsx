import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '@widedrop/shared';
import { ApiError, api } from '../../lib/api.js';
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
import { FormError, SelectField, TextAreaField, TextField } from '../../components/form/Field.js';
import styles from './HrScreens.module.css';

interface AnnouncementAdminResponse {
  items: {
    id: string;
    title: string;
    department: string;
    byline: string | null;
    status: string;
    isPinned: boolean;
    publishedAt: string | null;
    createdAt: string;
    readCount: number;
    audienceRuleCount: number;
  }[];
}

export function AnnouncementAdminScreen() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const announcements = useQuery({
    queryKey: ['hr', 'announcements'],
    queryFn: () => api.get<AnnouncementAdminResponse>('/api/v1/hr/announcements'),
  });

  const publish = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/hr/announcements/${id}/publish`, {}),
    onSuccess: async () => {
      toast.success('Published.');
      await queryClient.invalidateQueries({ queryKey: ['hr', 'announcements'] });
      await queryClient.invalidateQueries({ queryKey: ['announcements'] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'That could not be published.');
    },
  });

  if (announcements.error) {
    return <ErrorState error={announcements.error} onRetry={() => void announcements.refetch()} />;
  }

  return (
    <>
      <PageHeader
        title="Announcement admin"
        subtitle="An announcement reaches exactly the audience its rules name — never everybody by accident"
      />

      <SplitLayout variant="form">
        <DraftForm
          onCreated={() => queryClient.invalidateQueries({ queryKey: ['hr', 'announcements'] })}
        />

        <Stack>
          <Card title="Announcements" flush>
            {announcements.isPending ? (
              <div className={styles.padded}>
                <SkeletonLines count={4} />
              </div>
            ) : (announcements.data?.items.length ?? 0) === 0 ? (
              <EmptyState
                compact
                icon="announcements"
                title="Nothing drafted"
                body="Draft an announcement, give it an audience, and publish it when it is ready."
              />
            ) : (
              announcements.data?.items.map((announcement) => (
                <DataRow
                  key={announcement.id}
                  title={announcement.title}
                  meta={[
                    announcement.department,
                    announcement.publishedAt
                      ? `published ${formatDateTime(announcement.publishedAt)}`
                      : `drafted ${formatDateTime(announcement.createdAt)}`,
                    `${announcement.audienceRuleCount} audience ${announcement.audienceRuleCount === 1 ? 'rule' : 'rules'}`,
                    announcement.readCount > 0 ? `read by ${announcement.readCount}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  trailing={
                    <>
                      {announcement.isPinned ? (
                        <StatusChip label="Pinned" tone="amber" showDot={false} />
                      ) : null}
                      <StatusChip {...statusOf(announcement.status)} />
                      {announcement.status === 'DRAFT' ? (
                        <Button
                          size="small"
                          variant="primary"
                          busy={publish.isPending && publish.variables === announcement.id}
                          onClick={() => publish.mutate(announcement.id)}
                        >
                          Publish
                        </Button>
                      ) : null}
                    </>
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

function DraftForm({ onCreated }: { onCreated: () => Promise<unknown> }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [department, setDepartment] = useState('People Ops');
  const [body, setBody] = useState('');
  const [audienceKind, setAudienceKind] = useState('ALL');
  const [isPinned, setIsPinned] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paragraphs = body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/api/v1/hr/announcements', {
        title: title.trim(),
        departmentLabel: department.trim(),
        paragraphs,
        isPinned,
        audience: [{ kind: audienceKind }],
      }),
    onSuccess: async () => {
      setError(null);
      setTitle('');
      setBody('');
      toast.success('Drafted. Publish it when it is ready.');
      await onCreated();
    },
    onError: (failure: unknown) => {
      setError(failure instanceof ApiError ? failure.message : 'That could not be drafted.');
    },
  });

  return (
    <Card title="New announcement">
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <TextField
          label="Title"
          value={title}
          maxLength={160}
          required
          onChange={(event) => setTitle(event.target.value)}
        />
        <TextField
          label="From"
          value={department}
          maxLength={60}
          required
          hint="The team it comes from; the byline is resolved from your own record"
          onChange={(event) => setDepartment(event.target.value)}
        />
        <TextAreaField
          label="Body"
          rows={8}
          value={body}
          required
          hint="A blank line starts a new paragraph"
          onChange={(event) => setBody(event.target.value)}
        />
        <SelectField
          label="Audience"
          value={audienceKind}
          onChange={(event) => setAudienceKind(event.target.value)}
          hint="An announcement with no audience reaches nobody, and publishing is refused"
        >
          <option value="ALL">Everyone</option>
        </SelectField>

        <label className={styles.note}>
          <input
            type="checkbox"
            checked={isPinned}
            onChange={(event) => setIsPinned(event.target.checked)}
          />{' '}
          Pin to the top
        </label>

        <FormError message={error} />

        <Button
          type="submit"
          variant="primary"
          busy={create.isPending}
          disabled={title.trim().length < 4 || paragraphs.length === 0}
        >
          Save draft
        </Button>
      </form>
    </Card>
  );
}
