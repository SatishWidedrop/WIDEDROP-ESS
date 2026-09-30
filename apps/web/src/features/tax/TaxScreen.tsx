import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EMPTY_VALUE, formatDate, formatINR } from '@widedrop/shared';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { statusOf } from '../../lib/status.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow, Detail, DetailGrid, Meter } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { Icon } from '../../components/ui/Icon.js';
import { PageHeader, SplitLayout, Stack } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { useToast } from '../../components/ui/Toast.js';
import styles from './TaxScreen.module.css';

interface TaxResponse {
  fiscalYear: { startYear: number; label: string } | null;
  fiscalYears: { startYear: number; label: string }[];
  regime: {
    code: string;
    name: string;
    standardDeductionMinor: string;
    allowsDeductions: boolean;
    electedAt: string;
    isDefaultApplied: boolean;
  } | null;
  projection: {
    projectedGrossMinor: string;
    exemptionsMinor: string;
    deductionsMinor: string;
    taxableIncomeMinor: string;
    computedTaxMinor: string;
    cessMinor: string;
    totalLiabilityMinor: string;
    tdsDeductedToDateMinor: string;
    remainingLiabilityMinor: string;
    computedAt: string;
  } | null;
  quarters: {
    id: string;
    quarterNumber: number;
    label: string;
    startDate: string;
    endDate: string;
    status: string;
    tdsMinor: string | null;
    filingReference: string | null;
  }[];
  form16s: {
    id: string;
    fiscalYear: string;
    status: string;
    revision: number;
    issuedAt: string | null;
    hasDocument: boolean;
  }[];
  declaration: {
    id: string;
    status: string;
    submittedAt: string | null;
    verifiedAt: string | null;
    rejectionReason: string | null;
    items: {
      id: string;
      sectionCode: string;
      label: string;
      declaredMinor: string;
      verifiedMinor: string | null;
      note: string | null;
      hasProof: boolean;
    }[];
  } | null;
}

export function TaxScreen() {
  const toast = useToast();
  const [fiscalYear, setFiscalYear] = useState<number | undefined>();

  const tax = useQuery({
    queryKey: queryKeys.tax.summary(fiscalYear),
    queryFn: () =>
      api.get<TaxResponse>('/api/v1/tax', { query: { fiscalYear: fiscalYear ?? undefined } }),
  });

  async function download(id: string) {
    try {
      const { url } = await api.get<{ url: string }>(`/api/v1/tax/form16/${id}/document`);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That document could not be opened.');
    }
  }

  if (tax.error) return <ErrorState error={tax.error} onRetry={() => void tax.refetch()} />;

  const data = tax.data;
  const projection = data?.projection;

  return (
    <>
      <PageHeader
        title="Tax slips"
        subtitle="Form 16, TDS and your declaration"
        badge={
          data?.regime ? (
            <StatusChip
              label={`${data.regime.name} · ${data.fiscalYear?.label ?? ''}`.trim()}
              tone="blue"
              showDot={false}
              description={
                data.regime.isDefaultApplied
                  ? 'applied by default because no election was made in the window'
                  : undefined
              }
            />
          ) : null
        }
        actions={
          (data?.fiscalYears.length ?? 0) > 1 ? (
            <select
              className={styles.yearSelect}
              value={fiscalYear ?? data?.fiscalYear?.startYear ?? ''}
              onChange={(event) => setFiscalYear(Number(event.target.value))}
              aria-label="Financial year"
            >
              {data?.fiscalYears.map((year) => (
                <option key={year.startYear} value={year.startYear}>
                  {year.label}
                </option>
              ))}
            </select>
          ) : null
        }
      />

      {tax.isPending ? (
        <Card>
          <SkeletonLines count={5} />
        </Card>
      ) : !data?.fiscalYear ? (
        <EmptyState
          icon="tax"
          title="No financial year set up"
          body="People Ops opens the financial year before tax figures can be computed."
        />
      ) : (
        <SplitLayout variant="calendar">
          <Stack>
            <Card title={`TDS summary · ${data.fiscalYear.label}`}>
              {/*
                Shown only when payroll has computed a projection. Zeroes here
                would say no tax is due, which is a different claim from
                "payroll has not run yet".
              */}
              {projection ? (
                <>
                  <div className={styles.metric}>
                    {formatINR(Number(projection.totalLiabilityMinor))}
                  </div>
                  <div className={styles.metricNote}>
                    Projected annual tax, including cess · computed{' '}
                    {formatDate(projection.computedAt.slice(0, 10))}
                  </div>

                  <div className={styles.progress}>
                    <div className={styles.progressRow}>
                      <span>Deducted so far</span>
                      <span className={styles.progressValue}>
                        {formatINR(Number(projection.tdsDeductedToDateMinor))}
                        {Number(projection.totalLiabilityMinor) > 0
                          ? ` · ${Math.round(
                              (Number(projection.tdsDeductedToDateMinor) /
                                Number(projection.totalLiabilityMinor)) *
                                100,
                            )}%`
                          : ''}
                      </span>
                    </div>
                    <Meter
                      value={Number(projection.tdsDeductedToDateMinor)}
                      max={Number(projection.totalLiabilityMinor)}
                      label="Tax deducted against the projected liability"
                    />
                    <div className={styles.progressNote}>
                      {formatINR(Number(projection.remainingLiabilityMinor))} remaining
                    </div>
                  </div>

                  <DetailGrid>
                    <Detail
                      label="Projected gross"
                      value={formatINR(Number(projection.projectedGrossMinor))}
                    />
                    <Detail
                      label="Exemptions"
                      value={formatINR(Number(projection.exemptionsMinor))}
                    />
                    <Detail
                      label="Deductions"
                      value={formatINR(Number(projection.deductionsMinor))}
                    />
                    <Detail
                      label="Taxable income"
                      value={formatINR(Number(projection.taxableIncomeMinor))}
                    />
                  </DetailGrid>
                </>
              ) : (
                <EmptyState
                  compact
                  icon="tax"
                  title="No projection yet"
                  body="Your tax projection is computed when payroll runs for the year. It will appear here with the figures payroll actually used."
                />
              )}
            </Card>

            <Card
              title="Investment declaration"
              subtitle={
                data.declaration
                  ? `Form 12BB · ${statusOf(data.declaration.status).label}`
                  : 'Form 12BB'
              }
              flush
            >
              {!data.declaration || data.declaration.items.length === 0 ? (
                <EmptyState
                  compact
                  icon="tax"
                  title="Nothing declared"
                  body={
                    data.regime?.allowsDeductions === false
                      ? 'The regime recorded for this year does not allow chapter VI-A deductions, so there is nothing to declare.'
                      : 'Declare your investments so payroll can allow them when it computes your tax.'
                  }
                />
              ) : (
                data.declaration.items.map((item) => (
                  <DataRow
                    key={item.id}
                    title={item.label}
                    meta={[
                      item.sectionCode,
                      item.note,
                      item.hasProof ? 'proof attached' : 'no proof yet',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    value={formatINR(Number(item.verifiedMinor ?? item.declaredMinor))}
                    trailing={
                      item.verifiedMinor !== null ? (
                        <StatusChip label="Verified" tone="green" />
                      ) : (
                        <StatusChip label="Declared" tone="amber" />
                      )
                    }
                  />
                ))
              )}
            </Card>
          </Stack>

          <Stack>
            <Card title="Quarterly TDS" subtitle="Form 24Q" flush>
              {data.quarters.length === 0 ? (
                <EmptyState
                  compact
                  icon="tax"
                  title="No quarters yet"
                  body="Each quarter appears once payroll has run in it."
                />
              ) : (
                data.quarters.map((quarter) => {
                  const status = statusOf(quarter.status);
                  return (
                    <DataRow
                      key={quarter.id}
                      title={quarter.label}
                      meta={quarter.filingReference ?? undefined}
                      // Null until a payslip in the quarter has published:
                      // an em dash, never ₹0.
                      value={quarter.tdsMinor === null ? null : formatINR(Number(quarter.tdsMinor))}
                      trailing={<StatusChip label={status.label} tone={status.tone} />}
                    />
                  );
                })
              )}
            </Card>

            <Card title="Form 16" subtitle="Part A and Part B" flush>
              {data.form16s.length === 0 ? (
                <EmptyState
                  compact
                  icon="tax"
                  title="No Form 16 issued"
                  body="Form 16 is issued after the financial year closes and the fourth-quarter return is filed."
                />
              ) : (
                data.form16s.map((form16) => {
                  const status = statusOf(form16.status);
                  return (
                    <DataRow
                      key={form16.id}
                      leading={<Icon name="tax" size={18} className={styles.glyph} />}
                      title={`Form 16 · ${form16.fiscalYear}`}
                      meta={
                        form16.issuedAt
                          ? `Issued ${formatDate(form16.issuedAt.slice(0, 10))}${form16.revision > 1 ? ` · revision ${form16.revision}` : ''}`
                          : 'Not issued yet'
                      }
                      trailing={
                        form16.hasDocument ? (
                          <Button
                            size="small"
                            variant="secondary"
                            icon="download"
                            onClick={() => void download(form16.id)}
                          >
                            Download
                          </Button>
                        ) : (
                          <StatusChip label={status.label} tone={status.tone} />
                        )
                      }
                    />
                  );
                })
              )}
            </Card>
          </Stack>
        </SplitLayout>
      )}
    </>
  );
}

/** Kept for the rare case a screen wants the em dash directly. */
export const NOTHING = EMPTY_VALUE;
