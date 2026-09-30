import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatDate, formatDateRange, formatINR } from '@widedrop/shared';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { useUiCopy } from '../../lib/uiCopy.js';
import { useToast } from '../../components/ui/Toast.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { ListDetailSplit, ListRow } from '../../components/ui/ListDetail.js';
import { MetricGrid, MetricTile } from '../../components/ui/MetricTile.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import styles from './PayslipsScreen.module.css';

interface PayslipSummary {
  id: string;
  reference: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  payableDays: number;
  totalDays: number;
  lopDays: number;
  grossEarningsMinor: string;
  totalDeductionsMinor: string;
  netPayMinor: string;
  hasDocument: boolean;
}

interface PayslipListResponse {
  items: PayslipSummary[];
  fiscalYears: number[];
  fiscalYear: number | null;
  summary: {
    payslipCount: number;
    grossMinor: string;
    netMinor: string;
    tdsMinor: string;
    pfTotalMinor: string;
    coverageLabel: string | null;
  } | null;
}

interface PayslipLine {
  id: string;
  label: string;
  amountMinor: string;
  fullAmountMinor: string | null;
  note: string | null;
}

interface PayslipDetail {
  id: string;
  reference: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  employee: {
    name: string;
    employeeNumber: string;
    designation: string | null;
    department: string | null;
    location: string | null;
  };
  attendance: { payableDays: number; totalDays: number; lopDays: number };
  totals: {
    grossEarningsMinor: string;
    totalDeductionsMinor: string;
    netPayMinor: string;
    employerContributionMinor: string;
  };
  earnings: PayslipLine[];
  deductions: PayslipLine[];
  employerContributions: PayslipLine[];
  hasDocument: boolean;
}

export function PayslipsScreen() {
  const copy = useUiCopy();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [fiscalYear, setFiscalYear] = useState<number | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('payslip'));

  const list = useQuery({
    queryKey: queryKeys.payslips.list(fiscalYear),
    queryFn: () =>
      api.get<PayslipListResponse>('/api/v1/payslips', {
        query: { fiscalYear: fiscalYear ?? undefined },
      }),
  });

  // Select the most recent payslip once the list arrives, so the detail pane
  // is never an empty frame beside a populated list.
  useEffect(() => {
    if (!selectedId && list.data?.items[0]) setSelectedId(list.data.items[0].id);
  }, [list.data, selectedId]);

  const detail = useQuery({
    queryKey: queryKeys.payslips.detail(selectedId ?? ''),
    queryFn: () => api.get<PayslipDetail>(`/api/v1/payslips/${selectedId}`),
    enabled: selectedId !== null,
  });

  async function download(id: string) {
    try {
      const { url } = await api.get<{ url: string }>(`/api/v1/payslips/${id}/document`);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'That document could not be downloaded.',
      );
    }
  }

  if (list.error) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;

  const items = list.data?.items ?? [];
  const summary = list.data?.summary;

  return (
    <>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Payslips</h1>
          <p className={styles.subtitle}>
            {items.length > 0
              ? `${items.length} published ${items.length === 1 ? 'payslip' : 'payslips'}`
              : 'Your published payslips appear here'}
          </p>
        </div>

        {(list.data?.fiscalYears.length ?? 0) > 1 ? (
          <select
            className={styles.yearSelect}
            value={fiscalYear ?? list.data?.fiscalYear ?? ''}
            onChange={(event) => {
              setFiscalYear(Number(event.target.value));
              setSelectedId(null);
            }}
            aria-label="Financial year"
          >
            {list.data?.fiscalYears.map((year) => (
              <option key={year} value={year}>
                FY {year}&ndash;{String((year + 1) % 100).padStart(2, '0')}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {/*
        Year-to-date tiles. Rendered only when a rollup exists: with nothing
        published, four tiles reading ₹0 would assert that someone earned
        nothing, which is a different claim from "payroll has not run".
      */}
      {summary ? (
        <MetricGrid>
          <MetricTile
            label="Gross earned"
            value={formatINR(Number(summary.grossMinor))}
            sub={summary.coverageLabel}
          />
          <MetricTile
            label="Net credited"
            value={formatINR(Number(summary.netMinor))}
            sub={`${summary.payslipCount} ${summary.payslipCount === 1 ? 'payslip' : 'payslips'}`}
          />
          <MetricTile
            label="Tax deducted"
            value={formatINR(Number(summary.tdsMinor))}
            sub="Reflected in Form 26AS"
          />
          <MetricTile
            label="Provident fund"
            value={formatINR(Number(summary.pfTotalMinor))}
            sub="Employee and employer"
          />
        </MetricGrid>
      ) : null}

      {list.isPending ? (
        <Card>
          <SkeletonLines count={5} />
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon="payslips"
          title={copy('empty.payslips.title')}
          body={copy('empty.payslips.body')}
        />
      ) : (
        <ListDetailSplit
          list={
            <Card flush>
              {items.map((payslip) => (
                <ListRow
                  key={payslip.id}
                  title={payslip.label}
                  meta={`Paid ${formatDate(payslip.payDate)}`}
                  value={formatINR(Number(payslip.netPayMinor))}
                  selected={payslip.id === selectedId}
                  onSelect={() => {
                    setSelectedId(payslip.id);
                    setSearchParams({ payslip: payslip.id }, { replace: true });
                  }}
                />
              ))}
            </Card>
          }
          detail={
            detail.error ? (
              <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
            ) : detail.isPending || !detail.data ? (
              <Card>
                <SkeletonLines count={6} />
              </Card>
            ) : (
              <PayslipDetailView
                payslip={detail.data}
                onDownload={() => void download(detail.data.id)}
              />
            )
          }
        />
      )}
    </>
  );
}

function PayslipDetailView({
  payslip,
  onDownload,
}: {
  payslip: PayslipDetail;
  onDownload: () => void;
}) {
  const gross = Number(payslip.totals.grossEarningsMinor);
  const deductions = Number(payslip.totals.totalDeductionsMinor);
  const net = Number(payslip.totals.netPayMinor);
  const prorated = payslip.attendance.lopDays > 0;

  return (
    <>
      <Card
        title={payslip.label}
        subtitle={`${formatDateRange(payslip.periodStart, payslip.periodEnd)} · ${payslip.reference}`}
        actions={
          <div className={styles.actions}>
            {/*
              Offered only when the document exists. Until it is rendered the
              figures are still readable here, which is the part that matters.
            */}
            {payslip.hasDocument ? (
              <Button variant="secondary" icon="download" onClick={onDownload}>
                Download
              </Button>
            ) : null}
          </div>
        }
      >
        <div className={styles.netBar}>
          <div>
            <div className={styles.netLabel}>Net pay</div>
            <div className={styles.netValue}>{formatINR(net)}</div>
          </div>
          <div className={styles.netMeta}>
            Credited {formatDate(payslip.payDate)}
            <br />
            {payslip.employee.name} · {payslip.employee.employeeNumber}
            {payslip.employee.designation ? (
              <>
                <br />
                {payslip.employee.designation}
              </>
            ) : null}
          </div>
        </div>

        <div className={styles.attendance} style={{ marginTop: 'var(--space-9)' }}>
          <span>
            Payable days{' '}
            <span className={styles.attendanceValue}>
              {payslip.attendance.payableDays} / {payslip.attendance.totalDays}
            </span>
          </span>
          {prorated ? (
            <span>
              Loss of pay{' '}
              <span className={styles.attendanceValue}>
                {payslip.attendance.lopDays} {payslip.attendance.lopDays === 1 ? 'day' : 'days'}
              </span>
            </span>
          ) : null}
        </div>
      </Card>

      <Card title="Earnings and deductions">
        <div className={styles.columns}>
          <LineGroup
            heading="Earnings"
            lines={payslip.earnings}
            totalLabel="Gross earnings"
            total={gross}
          />
          <LineGroup
            heading="Deductions"
            lines={payslip.deductions}
            totalLabel="Total deductions"
            total={deductions}
          />
        </div>

        <div className={styles.total} style={{ marginTop: 'var(--space-10)' }}>
          <span>Net pay</span>
          <span className={styles.totalAmount}>{formatINR(net)}</span>
        </div>
      </Card>

      {payslip.employerContributions.length > 0 ? (
        <Card title="Paid by Widedrop" subtitle="In addition to your salary; not deducted from it">
          <div className={styles.lineGroup}>
            {payslip.employerContributions.map((line) => (
              <Line key={line.id} line={line} />
            ))}
          </div>
        </Card>
      ) : null}
    </>
  );
}

function LineGroup({
  heading,
  lines,
  totalLabel,
  total,
}: {
  heading: string;
  lines: PayslipLine[];
  totalLabel: string;
  total: number;
}) {
  return (
    <div className={styles.lineGroup}>
      <div className={styles.groupHeading}>{heading}</div>
      {lines.length === 0 ? (
        <p className={styles.footnote} style={{ paddingTop: 'var(--space-7)' }}>
          None this period.
        </p>
      ) : (
        lines.map((line) => <Line key={line.id} line={line} />)
      )}
      <div className={styles.total}>
        <span>{totalLabel}</span>
        <span className={styles.totalAmount}>{formatINR(total)}</span>
      </div>
    </div>
  );
}

function Line({ line }: { line: PayslipLine }) {
  const amount = Number(line.amountMinor);
  const full = line.fullAmountMinor === null ? null : Number(line.fullAmountMinor);

  return (
    <div className={styles.line}>
      <span className={styles.lineLabel}>
        {line.label}
        {line.note ? <span className={styles.lineNote}>{line.note}</span> : null}
      </span>
      <span className={styles.lineAmount}>
        {formatINR(amount)}
        {/* What the line would have been without loss of pay. */}
        {full !== null && full !== amount ? (
          <span className={styles.lineFull}>{formatINR(full)}</span>
        ) : null}
      </span>
    </div>
  );
}
