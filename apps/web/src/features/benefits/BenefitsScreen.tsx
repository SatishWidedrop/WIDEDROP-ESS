import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EMPTY_VALUE, formatDate, formatINR } from '@widedrop/shared';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { statusOf } from '../../lib/status.js';
import { Avatar } from '../../components/ui/Avatar.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { PageHeader, Stack } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { useToast } from '../../components/ui/Toast.js';
import styles from './BenefitsScreen.module.css';

interface BenefitPlan {
  id: string;
  code: string;
  name: string;
  category: string;
  provider: string | null;
  policyNumber: string | null;
  description: string | null;
  hasDocument: boolean;
  coverageKind: string;
  coverageValueMinor: string | null;
  coverageMultiplier: number | null;
  planYear: {
    id: string;
    startDate: string;
    endDate: string;
    enrolmentOpensOn: string | null;
    enrolmentClosesOn: string | null;
    employerContributionMinor: string | null;
    employeeContributionMinor: string | null;
  } | null;
  enrolment: {
    id: string;
    status: string;
    enrolledAt: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    hasCard: boolean;
    dependents: { id: string; fullName: string; relationship: string; initials: string }[];
  } | null;
  action: string;
  enrolmentWindowOpen: boolean;
}

interface BenefitsResponse {
  plans: BenefitPlan[];
  dependents: {
    id: string;
    fullName: string;
    relationship: string;
    dateOfBirth: string | null;
    initials: string;
  }[];
  nominees: {
    id: string;
    fullName: string;
    relationship: string;
    sharePercent: number;
    purpose: string;
  }[];
}

export function BenefitsScreen() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const benefits = useQuery({
    queryKey: queryKeys.benefits.enrolments,
    queryFn: () => api.get<BenefitsResponse>('/api/v1/benefits'),
  });

  async function enrol(plan: BenefitPlan) {
    if (!plan.planYear) return;
    try {
      await api.post('/api/v1/benefits/enrol', {
        benefitPlanYearId: plan.planYear.id,
        dependentIds: plan.enrolment?.dependents.map((dependent) => dependent.id) ?? [],
      });
      toast.success(`Enrolled in ${plan.name}.`);
      await queryClient.invalidateQueries({ queryKey: ['benefits'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That enrolment could not be saved.');
    }
  }

  if (benefits.error) {
    return <ErrorState error={benefits.error} onRetry={() => void benefits.refetch()} />;
  }

  const data = benefits.data;
  const planYear = data?.plans.find((plan) => plan.planYear)?.planYear;

  return (
    <>
      <PageHeader
        title="Benefits"
        subtitle={
          planYear
            ? `Your coverage and allowances · Plan year ${formatDate(planYear.startDate)} – ${formatDate(planYear.endDate)}`
            : 'Your coverage and allowances'
        }
      />

      {benefits.isPending ? (
        <Card>
          <SkeletonLines count={4} />
        </Card>
      ) : (data?.plans.length ?? 0) === 0 ? (
        <EmptyState
          icon="benefits"
          title="No benefit plans yet"
          body="People Ops publishes the plans and their coverage for each plan year. Yours will appear here."
        />
      ) : (
        <div className={styles.plans}>
          {data?.plans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} onEnrol={() => void enrol(plan)} />
          ))}
        </div>
      )}

      <Stack>
        <Card title="Dependents" subtitle="Covered under your family plans" flush>
          {(data?.dependents.length ?? 0) === 0 ? (
            <EmptyState
              compact
              icon="benefits"
              title="No dependents added"
              body="Add a dependent to include them when you enrol in a family plan."
            />
          ) : (
            data?.dependents.map((dependent) => (
              <DataRow
                key={dependent.id}
                leading={<Avatar initials={dependent.initials} size={30} />}
                title={dependent.fullName}
                meta={[
                  dependent.relationship.replace(/_/g, ' ').toLowerCase(),
                  dependent.dateOfBirth ? `born ${formatDate(dependent.dateOfBirth)}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            ))
          )}
        </Card>

        <Card title="Nominations" subtitle="Who receives what, and for which benefit" flush>
          {(data?.nominees.length ?? 0) === 0 ? (
            <EmptyState
              compact
              icon="benefits"
              title="No nominations recorded"
              body="Nominations for provident fund and group life are recorded by People Ops."
            />
          ) : (
            data?.nominees.map((nominee) => (
              <DataRow
                key={nominee.id}
                title={nominee.fullName}
                meta={`${nominee.relationship} · ${nominee.purpose.replace(/_/g, ' ').toLowerCase()}`}
                value={`${nominee.sharePercent}%`}
              />
            ))
          )}
        </Card>
      </Stack>
    </>
  );
}

function PlanCard({ plan, onEnrol }: { plan: BenefitPlan; onEnrol: () => void }) {
  const status = plan.enrolment ? statusOf(plan.enrolment.status) : null;

  // The employee's own resolved figure where they are enrolled, the plan's
  // otherwise. Never a multiple applied in the browser to a salary the
  // browser should not know.
  const coverage =
    plan.coverageValueMinor !== null ? formatINR(Number(plan.coverageValueMinor)) : EMPTY_VALUE;

  return (
    <div className={styles.plan}>
      <div className={styles.planCategory}>{plan.category.replace(/_/g, ' ')}</div>
      <div className={styles.planName}>{plan.name}</div>
      <div className={styles.planValue}>{coverage}</div>

      <div className={styles.planMeta}>
        {[
          plan.provider,
          plan.enrolment?.dependents.length
            ? `${plan.enrolment.dependents.length} ${plan.enrolment.dependents.length === 1 ? 'dependent' : 'dependents'} covered`
            : null,
          plan.planYear?.employeeContributionMinor
            ? `You pay ${formatINR(Number(plan.planYear.employeeContributionMinor))}`
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || plan.description}
      </div>

      <div className={styles.planFooter}>
        {status ? <StatusChip label={status.label} tone={status.tone} /> : null}
        {/*
          The button exists only when the server says the window is open and
          the plan defines an action. A card with no action renders none,
          rather than one that fails.
        */}
        {plan.enrolmentWindowOpen && plan.action === 'ENROL' ? (
          <Button size="small" variant="secondary" onClick={onEnrol}>
            {plan.enrolment?.status === 'ENROLLED' ? 'Update enrolment' : 'Enrol'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
