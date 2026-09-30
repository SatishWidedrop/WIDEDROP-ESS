import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, formatINR, rupeesToPaise, toIsoDate } from '@widedrop/shared';
import { ApiError, api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { statusOf } from '../../lib/status.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow, Reference } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { MetricGrid, MetricTile } from '../../components/ui/MetricTile.js';
import { PageHeader } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { useToast } from '../../components/ui/Toast.js';
import { FieldRow, FormError, SelectField, TextField } from '../../components/form/Field.js';
import styles from './ExpensesScreen.module.css';

interface ExpenseCategory {
  id: string;
  code: string;
  name: string;
  description: string | null;
  requiresReceipt: boolean;
  submissionWindowDays: number;
}

interface ExpenseClaim {
  id: string;
  reference: string;
  title: string;
  status: string;
  totalAmountMinor: string;
  approvedAmountMinor: string | null;
  spendDate: string;
  reimbursedAt: string | null;
  employee: { id: string; fullName: string; initials: string };
  lineCount: number;
  attachmentCount: number;
  payingWith: { label: string; payDate: string; batchReference: string } | null;
  canSubmit: boolean;
  canWithdraw: boolean;
}

interface ExpensesResponse {
  items: ExpenseClaim[];
  categories: ExpenseCategory[];
  summary: {
    fiscalYear: string;
    pendingCount: number;
    pendingMinor: string;
    approvedCount: number;
    approvedMinor: string;
    reimbursedCount: number;
    reimbursedMinor: string;
    rejectedCount: number;
  } | null;
}

export function ExpensesScreen() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  /** Which claim's bills are showing. One at a time, as the prototype's lists do. */
  const [openBills, setOpenBills] = useState<string | null>(null);

  const list = useQuery({
    queryKey: queryKeys.expenses.list(),
    queryFn: () => api.get<ExpensesResponse>('/api/v1/expenses'),
  });

  async function act(id: string, action: 'submit' | 'withdraw') {
    try {
      await api.post(`/api/v1/expenses/${id}/${action}`, {});
      toast.success(action === 'submit' ? 'Claim submitted to your manager.' : 'Claim withdrawn.');
      await queryClient.invalidateQueries({ queryKey: ['expenses'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That could not be done.');
    }
  }

  if (list.error) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;

  const data = list.data;
  const summary = data?.summary;

  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle="Claims approved by Accounts are paid with the payroll cycle they are batched into"
        actions={
          <Button variant={formOpen ? 'ghost' : 'primary'} onClick={() => setFormOpen((v) => !v)}>
            {formOpen ? 'Cancel' : 'New claim'}
          </Button>
        }
      />

      {/*
        Three tiles, shown only when a rollup exists. Zeroes here would claim
        somebody submitted nothing this year, which is a different thing from
        the year not having started for them.
      */}
      {summary ? (
        <MetricGrid>
          <MetricTile
            label="Awaiting a decision"
            value={formatINR(Number(summary.pendingMinor))}
            sub={`${summary.pendingCount} ${summary.pendingCount === 1 ? 'claim' : 'claims'}`}
          />
          <MetricTile
            label="Approved, not yet paid"
            value={formatINR(Number(summary.approvedMinor))}
            sub={`${summary.approvedCount} ${summary.approvedCount === 1 ? 'claim' : 'claims'}`}
          />
          <MetricTile
            label="Reimbursed"
            value={formatINR(Number(summary.reimbursedMinor))}
            sub={summary.fiscalYear}
          />
        </MetricGrid>
      ) : null}

      {formOpen ? (
        <NewClaimForm
          categories={data?.categories ?? []}
          onCreated={async () => {
            setFormOpen(false);
            await queryClient.invalidateQueries({ queryKey: ['expenses'] });
          }}
        />
      ) : null}

      <Card title="My claims" subtitle={summary?.fiscalYear ?? undefined} flush>
        {list.isPending ? (
          <div className={styles.padded}>
            <SkeletonLines count={4} />
          </div>
        ) : (data?.items.length ?? 0) === 0 ? (
          <EmptyState
            icon="expenses"
            title="No claims yet"
            body="A claim you submit appears here with its reference, where it has got to, and — once Accounts approves it — which payroll cycle will pay it."
          />
        ) : (
          data?.items.map((claim) => {
            const status = statusOf(claim.status);
            const payable = claim.approvedAmountMinor ?? claim.totalAmountMinor;

            return (
              <div key={claim.id}>
                <DataRow
                  leading={<Reference>{claim.reference}</Reference>}
                  title={claim.title}
                  meta={[
                    `Spent ${formatDate(claim.spendDate)}`,
                    claim.lineCount > 1 ? `${claim.lineCount} lines` : null,
                    claim.attachmentCount > 0
                      ? `${claim.attachmentCount} ${claim.attachmentCount === 1 ? 'receipt' : 'receipts'}`
                      : null,
                    // A fact, not a promise: the cycle is a row that names it.
                    claim.payingWith
                      ? `Paying with ${claim.payingWith.label} on ${formatDate(claim.payingWith.payDate)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  value={formatINR(Number(payable))}
                  trailing={
                    <>
                      {/*
                      Shown when there is something to see or something to
                      attach, and never otherwise: a "Bills (0)" button on a
                      submitted claim with no receipt is a control that does
                      nothing.
                    */}
                      {claim.canSubmit || claim.attachmentCount > 0 ? (
                        <Button
                          size="small"
                          variant="ghost"
                          onClick={() =>
                            setOpenBills((open) => (open === claim.id ? null : claim.id))
                          }
                        >
                          {openBills === claim.id ? 'Hide bills' : 'Bills'}
                        </Button>
                      ) : null}
                      {claim.canSubmit ? (
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => void act(claim.id, 'submit')}
                        >
                          Submit
                        </Button>
                      ) : null}
                      {claim.canWithdraw ? (
                        <Button
                          size="small"
                          variant="ghost"
                          onClick={() => void act(claim.id, 'withdraw')}
                        >
                          Withdraw
                        </Button>
                      ) : null}
                      <StatusChip
                        label={status.label}
                        tone={status.tone}
                        description={status.description}
                      />
                    </>
                  }
                />
                {openBills === claim.id ? (
                  <BillsPanel
                    claimId={claim.id}
                    canChange={claim.canSubmit}
                    requiresReceipt={
                      data?.categories.some((category) => category.requiresReceipt) ?? false
                    }
                  />
                ) : null}
              </div>
            );
          })
        )}
      </Card>
    </>
  );
}

function NewClaimForm({
  categories,
  onCreated,
}: {
  categories: ExpenseCategory[];
  onCreated: () => Promise<void>;
}) {
  const toast = useToast();
  const today = toIsoDate(new Date());

  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [spendDate, setSpendDate] = useState(today);
  const [error, setError] = useState<string | null>(null);

  const chosen = categories.find((category) => category.id === categoryId) ?? categories[0];

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string; reference: string }>('/api/v1/expenses', {
        title: title.trim(),
        lines: [
          {
            expenseCategoryId: categoryId || categories[0]?.id,
            description: description.trim(),
            spendDate,
            // Rupees in the field, paise on the wire. The conversion happens
            // once, here, and never with a float multiplication downstream.
            amountMinor: rupeesToPaise(Number(amount)),
          },
        ],
      }),
    onSuccess: async (created) => {
      setError(null);
      toast.success(`${created.reference} created. Submit it when the receipt is attached.`);
      await onCreated();
    },
    onError: (failure: unknown) => {
      setError(
        failure instanceof ApiError
          ? failure.message
          : 'That claim could not be created. Try again.',
      );
    },
  });

  if (categories.length === 0) {
    return (
      <Card title="New claim">
        <EmptyState
          compact
          icon="expenses"
          title="No expense categories configured"
          body="Accounts sets up the categories and their limits before claims can be made."
        />
      </Card>
    );
  }

  const parsed = Number(amount);
  const valid =
    title.trim().length >= 2 &&
    description.trim().length >= 2 &&
    Number.isFinite(parsed) &&
    parsed > 0;

  return (
    <Card title="New claim">
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
          maxLength={120}
          required
          placeholder="What the claim is for"
          onChange={(event) => setTitle(event.target.value)}
        />

        <FieldRow>
          <SelectField
            label="Category"
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            hint={
              chosen
                ? `Claim within ${chosen.submissionWindowDays} days${chosen.requiresReceipt ? '; receipt required' : ''}`
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
            label="Amount (₹)"
            type="number"
            min="1"
            step="0.01"
            value={amount}
            required
            placeholder="0"
            onChange={(event) => setAmount(event.target.value)}
          />

          <TextField
            label="Date of spend"
            type="date"
            value={spendDate}
            max={today}
            onChange={(event) => setSpendDate(event.target.value)}
          />
        </FieldRow>

        <TextField
          label="Description"
          value={description}
          maxLength={200}
          required
          placeholder="Merchant and purpose, e.g. Uber — client visit to Manyata"
          onChange={(event) => setDescription(event.target.value)}
        />

        <FormError message={error} />

        <div className={styles.actions}>
          <Button type="submit" variant="primary" busy={create.isPending} disabled={!valid}>
            Create claim
          </Button>
          <span className={styles.note}>Goes to your manager, then to Accounts</span>
        </div>
      </form>
    </Card>
  );
}

/**
 * The bills on one claim.
 *
 * Attaching and removing are draft-only, which is the server's rule and is
 * reflected here rather than reimplemented: `canChange` comes from the same
 * `canSubmit` flag the API computes, so the two cannot drift. A claim that has
 * gone to a manager shows its bills read-only, because the thing approved and
 * the thing on file have to stay the same thing.
 */
function BillsPanel({
  claimId,
  canChange,
  requiresReceipt,
}: {
  claimId: string;
  canChange: boolean;
  requiresReceipt: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const inputId = `bill-${claimId}`;
  const [busy, setBusy] = useState(false);

  const bills = useQuery({
    queryKey: queryKeys.expenses.attachments(claimId),
    queryFn: () => api.get<{ items: Bill[] }>(`/api/v1/expenses/${claimId}/attachments`),
  });

  async function attach(file: File) {
    setBusy(true);
    try {
      await api.upload(`/api/v1/expenses/${claimId}/attachments`, file);
      toast.success(`${file.name} attached.`);
      await queryClient.invalidateQueries({ queryKey: ['expenses'] });
    } catch (error) {
      // The server's message is the useful one — it names the real type of a
      // file that lied about itself, or the size limit it exceeded.
      toast.error(error instanceof Error ? error.message : 'That file could not be attached.');
    } finally {
      setBusy(false);
    }
  }

  async function open(bill: Bill) {
    try {
      const { url } = await api.get<{ url: string }>(
        `/api/v1/expenses/${claimId}/attachments/${bill.id}`,
      );
      // A fresh short-lived URL each time, rather than one held in the page:
      // the URL is the capability, so it is fetched when it is about to be used.
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That bill could not be opened.');
    }
  }

  async function remove(bill: Bill) {
    try {
      await api.delete(`/api/v1/expenses/${claimId}/attachments/${bill.id}`);
      toast.success(`${bill.filename} removed.`);
      await queryClient.invalidateQueries({ queryKey: ['expenses'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That bill could not be removed.');
    }
  }

  if (bills.error) {
    return (
      <div className={styles.bills}>
        <ErrorState error={bills.error} onRetry={() => void bills.refetch()} />
      </div>
    );
  }

  const items = bills.data?.items ?? [];

  return (
    <div className={styles.bills}>
      {bills.isPending ? (
        <SkeletonLines count={2} />
      ) : items.length === 0 ? (
        <p className={styles.note}>
          {canChange
            ? requiresReceipt
              ? 'No bill attached yet. A category that requires a receipt will not pass approval without one.'
              : 'No bill attached yet.'
            : 'This claim was submitted without a bill.'}
        </p>
      ) : (
        <ul className={styles.billList}>
          {items.map((bill) => (
            <li key={bill.id} className={styles.bill}>
              <button type="button" className={styles.billName} onClick={() => void open(bill)}>
                {bill.filename}
              </button>
              <span className={styles.billMeta}>{formatBytes(bill.sizeBytes)}</span>
              {canChange ? (
                <Button size="small" variant="ghost" onClick={() => void remove(bill)}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canChange ? (
        <div className={styles.actions}>
          {/*
            A real file input, labelled. Styled through the label rather than
            replaced by a button that clicks it, so it keeps its keyboard
            behaviour and its announcement to a screen reader.
          */}
          <span className={styles.attachWrap}>
            <input
              id={inputId}
              className={styles.fileInput}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared so choosing the same file twice fires a change again.
                event.target.value = '';
                if (file) void attach(file);
              }}
            />
            <label className={styles.attach} htmlFor={inputId}>
              {busy ? 'Attaching…' : 'Attach a bill'}
            </label>
          </span>
          <span className={styles.note}>PDF, JPEG, PNG or WebP · up to 10 MB · at most 5</span>
        </div>
      ) : null}
    </div>
  );
}

interface Bill {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
}

/** Bytes as a person reads them. Not a business figure, so rounding is fine. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
