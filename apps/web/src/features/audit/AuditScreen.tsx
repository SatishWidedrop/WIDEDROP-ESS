import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { formatDateTime } from '@widedrop/shared';
import { api } from '../../lib/api.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { Icon } from '../../components/ui/Icon.js';
import { PageHeader } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { useToast } from '../../components/ui/Toast.js';
import { SelectField, TextField } from '../../components/form/Field.js';
import styles from './AuditScreen.module.css';

interface AuditEvent {
  id: string;
  sequence: string;
  action: string;
  entityType: string;
  entityId: string | null;
  fromState: string | null;
  toState: string | null;
  summary: string | null;
  actor: {
    kind: string;
    persona: string | null;
    userId: string | null;
    employeeId: string | null;
    name: string | null;
  };
  ip: string | null;
  requestId: string | null;
  occurredAt: string;
}

interface Verification {
  valid: boolean;
  checked: number;
  from: string | null;
  to: string | null;
  brokenAt: { id: string; sequence: string; reason: string } | null;
  gaps: string[];
}

const ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'READ_SENSITIVE',
  'LOGIN',
  'LOGOUT',
  'STATE_TRANSITION',
  'ACKNOWLEDGE',
  'EXPORT',
  'DOWNLOAD',
  'PERMISSION_GRANT',
  'PERMISSION_REVOKE',
  'CONFIG_CHANGE',
] as const;

export function AuditScreen() {
  const toast = useToast();
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const events = useQuery({
    queryKey: ['audit', 'events', { action, entityType, from, to }],
    queryFn: () =>
      api.get<{ items: AuditEvent[]; nextCursor: string | null }>('/api/v1/audit', {
        query: {
          action: action || undefined,
          entityType: entityType || undefined,
          from: from || undefined,
          to: to || undefined,
        },
      }),
  });

  const verify = useMutation({
    mutationFn: () => api.get<Verification>('/api/v1/audit/verify'),
    onSuccess: (result) => {
      if (result.valid) {
        toast.success(`${result.checked} entries verified. The chain is intact.`);
      } else {
        toast.error(
          result.brokenAt
            ? `The chain breaks at entry ${result.brokenAt.sequence} (${result.brokenAt.reason}).`
            : `${result.gaps.length} entries are missing from the chain.`,
        );
      }
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'The chain could not be verified.');
    },
  });

  if (events.error)
    return <ErrorState error={events.error} onRetry={() => void events.refetch()} />;

  const items = events.data?.items ?? [];
  const result = verify.data;

  return (
    <>
      <PageHeader
        title="Audit trail"
        subtitle="Append-only and hash-chained with a key the database never sees. A row altered in place no longer reproduces its own digest."
        actions={
          <Button
            variant="secondary"
            icon="audit"
            busy={verify.isPending}
            onClick={() => verify.mutate()}
          >
            Verify the chain
          </Button>
        }
      />

      {/* The verification result, stated plainly. This is the difference
          between a log somebody could have edited and evidence. */}
      {result ? (
        <div className={result.valid ? styles.verifiedOk : styles.verifiedBroken} role="status">
          <Icon name={result.valid ? 'check' : 'alert'} size={18} />
          <div>
            <div className={styles.verifiedTitle}>
              {result.valid
                ? `${result.checked} entries verified — the chain is intact`
                : 'The chain is broken'}
            </div>
            <div className={styles.verifiedBody}>
              {result.valid
                ? `Every entry from ${result.from ?? '—'} to ${result.to ?? '—'} reproduces its own digest and links to its predecessor, with no gaps.`
                : result.brokenAt
                  ? `Entry ${result.brokenAt.sequence} fails its ${result.brokenAt.reason.replace('-', ' ')}. Everything after it is suspect.`
                  : `The sequence skips ${result.gaps.length} ${result.gaps.length === 1 ? 'entry' : 'entries'}: ${result.gaps.slice(0, 8).join(', ')}.`}
            </div>
          </div>
        </div>
      ) : null}

      <Card
        title="Events"
        subtitle="Searching the trail is itself recorded, with the filters used"
        actions={
          <div className={styles.filters}>
            <SelectField
              label="Action"
              value={action}
              onChange={(event) => setAction(event.target.value)}
            >
              <option value="">All actions</option>
              {ACTIONS.map((value) => (
                <option key={value} value={value}>
                  {value.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Entity type"
              value={entityType}
              placeholder="e.g. payslip"
              onChange={(event) => setEntityType(event.target.value)}
            />
            <TextField
              label="From"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
            <TextField
              label="To"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
        }
        flush
      >
        {events.isPending ? (
          <div className={styles.padded}>
            <SkeletonLines count={8} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon="audit"
            title="Nothing matched"
            body="Every sensitive read, every state change and every administrative action lands here as it happens. Widen the filters to see more."
          />
        ) : (
          <div className={styles.table}>
            {items.map((event) => (
              <div key={event.id} className={styles.row}>
                <span className={styles.sequence}>{event.sequence}</span>
                <span className={styles.main}>
                  <span className={styles.summary}>
                    {event.summary ?? `${event.action} on ${event.entityType}`}
                  </span>
                  <span className={styles.meta}>
                    {[
                      event.entityType,
                      event.fromState && event.toState
                        ? `${event.fromState} → ${event.toState}`
                        : null,
                      event.requestId ? `request ${event.requestId}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className={styles.actor}>
                  <span className={styles.actorName}>
                    {event.actor.name ?? event.actor.kind.toLowerCase()}
                  </span>
                  <span className={styles.meta}>
                    {[event.actor.persona, event.ip].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className={styles.action}>
                  <StatusChip
                    label={event.action.replace(/_/g, ' ').toLowerCase()}
                    tone={toneFor(event.action)}
                    showDot={false}
                  />
                </span>
                <span className={styles.time}>{formatDateTime(event.occurredAt)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

/** Reads that touch personal data and permission changes stand out. */
function toneFor(action: string): 'green' | 'amber' | 'red' | 'blue' | 'gray' {
  if (action === 'DELETE' || action === 'PERMISSION_REVOKE' || action === 'IMPERSONATE') {
    return 'red';
  }
  if (action === 'READ_SENSITIVE' || action === 'EXPORT' || action === 'DOWNLOAD') return 'amber';
  if (action === 'STATE_TRANSITION' || action === 'ACKNOWLEDGE') return 'blue';
  return 'gray';
}
