import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '@widedrop/shared';
import { ApiError, api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { statusOf } from '../../lib/status.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow, Reference } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { Icon } from '../../components/ui/Icon.js';
import { PageHeader, SplitLayout, Stack } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { useToast } from '../../components/ui/Toast.js';
import { FormError, SelectField, TextAreaField, TextField } from '../../components/form/Field.js';
import styles from './HelpScreen.module.css';

interface HelpOverview {
  categories: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    firstResponseHours: number;
    resolutionHours: number;
  }[];
  faqs: { id: string; question: string; answer: string; ticketCategoryId: string | null }[];
  helpdeskEmail: string;
  tickets: {
    id: string;
    reference: string;
    subject: string;
    status: string;
    priority: string;
    category: string;
    assignee: { fullName: string; initials: string } | null;
    createdAt: string;
    firstResponseDueAt: string | null;
    firstResponseAt: string | null;
    resolvedAt: string | null;
    commentCount: number;
  }[];
}

interface TicketDetail {
  id: string;
  reference: string;
  subject: string;
  description: string;
  status: string;
  priority: string;
  createdAt: string;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  category: { id: string; name: string };
  requester: { id: string; fullName: string; initials: string; employeeNumber: string };
  assignee: { id: string; fullName: string; initials: string } | null;
  comments: {
    id: string;
    body: string;
    visibility: string;
    createdAt: string;
    author: { id: string; fullName: string; initials: string } | null;
  }[];
  viewerIsAgent: boolean;
}

export function HelpScreen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('ticket'));

  const overview = useQuery({
    queryKey: queryKeys.help.tickets(),
    queryFn: () => api.get<HelpOverview>('/api/v1/help'),
  });

  if (overview.error) {
    return <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />;
  }

  const data = overview.data;

  return (
    <>
      <PageHeader
        title="Help desk"
        subtitle={
          data
            ? `Raise a request to People Ops, Payroll or IT · Tickets reach ${data.helpdeskEmail}`
            : 'Raise a request to People Ops, Payroll or IT'
        }
      />

      {selectedId ? (
        <TicketThread
          ticketId={selectedId}
          onBack={() => {
            setSelectedId(null);
            setSearchParams({}, { replace: true });
          }}
        />
      ) : (
        <SplitLayout variant="form">
          <RaiseTicketForm
            categories={data?.categories ?? []}
            loading={overview.isPending}
            onRaised={(id) => {
              setSelectedId(id);
              setSearchParams({ ticket: id }, { replace: true });
            }}
          />

          <Stack>
            <Card title="My tickets" flush>
              {overview.isPending ? (
                <div className={styles.padded}>
                  <SkeletonLines count={3} />
                </div>
              ) : (data?.tickets.length ?? 0) === 0 ? (
                <EmptyState
                  compact
                  icon="help"
                  title="No tickets yet"
                  body="Anything you raise appears here with its reference, so you can follow it."
                />
              ) : (
                data?.tickets.map((ticket) => {
                  const status = statusOf(ticket.status);
                  return (
                    <DataRow
                      key={ticket.id}
                      leading={<Reference>{ticket.reference}</Reference>}
                      title={ticket.subject}
                      meta={`${ticket.category} · raised ${formatDateTime(ticket.createdAt)}`}
                      onClick={() => {
                        setSelectedId(ticket.id);
                        setSearchParams({ ticket: ticket.id }, { replace: true });
                      }}
                      trailing={<StatusChip label={status.label} tone={status.tone} />}
                    />
                  );
                })
              )}
            </Card>

            <Card title="Common questions" flush>
              {(data?.faqs.length ?? 0) === 0 ? (
                <EmptyState
                  compact
                  icon="help"
                  title="No questions published"
                  body="People Ops adds answers to the questions the help desk hears most."
                />
              ) : (
                data?.faqs.map((faq) => (
                  <Faq key={faq.id} question={faq.question} answer={faq.answer} />
                ))
              )}
            </Card>
          </Stack>
        </SplitLayout>
      )}
    </>
  );
}

function Faq({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={styles.faq}>
      <button
        type="button"
        className={styles.faqQuestion}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span>{question}</span>
        <Icon name="chevronDown" size={16} className={open ? styles.chevronOpen : styles.chevron} />
      </button>
      {open ? <p className={styles.faqAnswer}>{answer}</p> : null}
    </div>
  );
}

function RaiseTicketForm({
  categories,
  loading,
  onRaised,
}: {
  categories: HelpOverview['categories'];
  loading: boolean;
  onRaised: (id: string) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [categoryId, setCategoryId] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const chosen = categories.find((category) => category.id === (categoryId || categories[0]?.id));

  const submit = useMutation({
    mutationFn: () =>
      api.post<{ id: string; reference: string; notificationQueued: boolean }>(
        '/api/v1/help/tickets',
        {
          ticketCategoryId: categoryId || categories[0]?.id,
          subject: subject.trim(),
          description: description.trim(),
        },
      ),
    onSuccess: async (created) => {
      setError(null);
      setSubject('');
      setDescription('');
      // Reported as queued rather than sent, because that is what is true at
      // this moment: the worker delivers it.
      toast.success(
        created.notificationQueued
          ? `${created.reference} raised. The help desk has been notified.`
          : `${created.reference} raised.`,
      );
      await queryClient.invalidateQueries({ queryKey: ['help'] });
      await queryClient.invalidateQueries({ queryKey: queryKeys.badges });
      onRaised(created.id);
    },
    onError: (failure: unknown) => {
      setError(
        failure instanceof ApiError
          ? failure.message
          : 'That ticket could not be raised. Try again.',
      );
    },
  });

  if (loading) {
    return (
      <Card title="Raise a ticket">
        <SkeletonLines count={4} />
      </Card>
    );
  }

  if (categories.length === 0) {
    return (
      <Card title="Raise a ticket">
        <EmptyState
          compact
          icon="help"
          title="No categories configured"
          body="People Ops sets up the help-desk categories before tickets can be raised."
        />
      </Card>
    );
  }

  return (
    <Card title="Raise a ticket">
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          submit.mutate();
        }}
      >
        <SelectField
          label="Category"
          value={categoryId || categories[0]?.id}
          onChange={(event) => setCategoryId(event.target.value)}
          hint={
            chosen
              ? `First reply within ${chosen.firstResponseHours} hours, resolved within ${chosen.resolutionHours}`
              : undefined
          }
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </SelectField>

        <TextField
          label="Subject"
          value={subject}
          maxLength={160}
          required
          placeholder="One line summary"
          onChange={(event) => setSubject(event.target.value)}
        />

        <TextAreaField
          label="Details"
          rows={5}
          value={description}
          maxLength={5000}
          required
          placeholder="What happened, and what you expected"
          onChange={(event) => setDescription(event.target.value)}
        />

        <FormError message={error} />

        <Button
          type="submit"
          variant="primary"
          busy={submit.isPending}
          disabled={subject.trim().length < 4 || description.trim().length < 10}
        >
          Submit ticket
        </Button>
      </form>
    </Card>
  );
}

function TicketThread({ ticketId, onBack }: { ticketId: string; onBack: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reply, setReply] = useState('');

  const ticket = useQuery({
    queryKey: queryKeys.help.ticket(ticketId),
    queryFn: () => api.get<TicketDetail>(`/api/v1/help/tickets/${ticketId}`),
  });

  const comment = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/help/tickets/${ticketId}/comments`, {
        body: reply.trim(),
        internal: false,
      }),
    onSuccess: async () => {
      setReply('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.help.ticket(ticketId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.help.tickets() });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'That reply could not be posted.');
    },
  });

  if (ticket.error)
    return <ErrorState error={ticket.error} onRetry={() => void ticket.refetch()} />;
  if (ticket.isPending || !ticket.data) {
    return (
      <Card>
        <SkeletonLines count={6} />
      </Card>
    );
  }

  const data = ticket.data;
  const status = statusOf(data.status);

  return (
    <Stack>
      <Card
        title={data.subject}
        subtitle={`${data.reference} · ${data.category.name} · raised ${formatDateTime(data.createdAt)}`}
        actions={
          <>
            <StatusChip label={status.label} tone={status.tone} />
            <Button variant="ghost" onClick={onBack}>
              Back to tickets
            </Button>
          </>
        }
      >
        <p className={styles.description}>{data.description}</p>

        <div className={styles.sla}>
          {data.firstResponseDueAt ? (
            <span>
              First reply {data.resolvedAt ? 'was' : 'due'}{' '}
              <strong>{formatDateTime(data.firstResponseDueAt)}</strong>
            </span>
          ) : null}
          {data.assignee ? (
            <span>
              With <strong>{data.assignee.fullName}</strong>
            </span>
          ) : (
            <span>Not yet assigned</span>
          )}
        </div>
      </Card>

      <Card title="Conversation" flush>
        {data.comments.length === 0 ? (
          <EmptyState
            compact
            icon="help"
            title="No replies yet"
            body="The help desk replies here, and you will be notified when they do."
          />
        ) : (
          <div className={styles.thread}>
            {data.comments.map((entry) => (
              <div key={entry.id} className={styles.comment}>
                <div className={styles.commentHead}>
                  <span className={styles.commentAuthor}>
                    {entry.author?.fullName ?? 'Widedrop'}
                  </span>
                  {entry.visibility === 'INTERNAL' ? (
                    <StatusChip label="Internal note" tone="gray" showDot={false} />
                  ) : null}
                  <span className={styles.commentTime}>{formatDateTime(entry.createdAt)}</span>
                </div>
                <p className={styles.commentBody}>{entry.body}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      {['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_ON_EMPLOYEE', 'REOPENED'].includes(
        data.status,
      ) ? (
        <Card title="Reply">
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              comment.mutate();
            }}
          >
            <TextAreaField
              label="Your reply"
              rows={4}
              value={reply}
              maxLength={5000}
              onChange={(event) => setReply(event.target.value)}
              placeholder="Add anything that would help"
            />
            <Button
              type="submit"
              variant="primary"
              busy={comment.isPending}
              disabled={reply.trim().length === 0}
            >
              Send reply
            </Button>
          </form>
        </Card>
      ) : null}
    </Stack>
  );
}
