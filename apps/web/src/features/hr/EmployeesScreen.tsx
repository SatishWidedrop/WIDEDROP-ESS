import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDate } from '@widedrop/shared';
import { api } from '../../lib/api.js';
import { statusOf } from '../../lib/status.js';
import { Avatar } from '../../components/ui/Avatar.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { MetricGrid, MetricTile } from '../../components/ui/MetricTile.js';
import { PageHeader } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { SelectField, TextField } from '../../components/form/Field.js';
import styles from './HrScreens.module.css';

interface EmployeesResponse {
  items: {
    id: string;
    employeeNumber: string;
    fullName: string;
    initials: string;
    workEmail: string;
    dateOfJoining: string;
    dateOfExit: string | null;
    employmentStatus: string;
    hasPortalAccount: boolean;
    employmentType: string | null;
    designation: string | null;
    department: string | null;
    location: string | null;
    manager: { id: string; fullName: string } | null;
  }[];
  counts: Record<string, number>;
  total: number;
  departments: { id: string; name: string }[];
}

export function EmployeesScreen() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [departmentId, setDepartmentId] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const employees = useQuery({
    queryKey: ['hr', 'employees', { debounced, status, departmentId }],
    queryFn: () =>
      api.get<EmployeesResponse>('/api/v1/hr/employees', {
        query: {
          q: debounced || undefined,
          status: status || undefined,
          departmentId: departmentId || undefined,
        },
      }),
  });

  if (employees.error) {
    return <ErrorState error={employees.error} onRetry={() => void employees.refetch()} />;
  }

  const data = employees.data;

  return (
    <>
      <PageHeader
        title="Employees"
        subtitle={
          data
            ? `${data.items.length} shown of ${data.total} on the rolls`
            : 'People records across the organisation'
        }
        actions={
          <div className={styles.filters}>
            <TextField
              label="Search"
              type="search"
              value={query}
              placeholder="Name, email or number"
              onChange={(event) => setQuery(event.target.value)}
            />
            <SelectField
              label="Status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="ON_LEAVE">On leave</option>
              <option value="NOTICE_PERIOD">Notice period</option>
              <option value="PRE_JOINING">Pre-joining</option>
              <option value="EXITED">Exited</option>
            </SelectField>
            <SelectField
              label="Department"
              value={departmentId}
              onChange={(event) => setDepartmentId(event.target.value)}
            >
              <option value="">All departments</option>
              {data?.departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </SelectField>
          </div>
        }
      />

      {/* Counts from one grouped query, so the tiles and the list cannot
          disagree about how many people are on the rolls. */}
      {data ? (
        <MetricGrid>
          <MetricTile label="Active" value={String(data.counts.ACTIVE ?? 0)} sub="signing in" />
          <MetricTile
            label="On notice"
            value={String(data.counts.NOTICE_PERIOD ?? 0)}
            sub="leaving soon"
          />
          <MetricTile
            label="Pre-joining"
            value={String(data.counts.PRE_JOINING ?? 0)}
            sub="not yet started"
          />
          <MetricTile label="Exited" value={String(data.counts.EXITED ?? 0)} sub="off the rolls" />
        </MetricGrid>
      ) : null}

      <Card flush>
        {employees.isPending ? (
          <div className={styles.padded}>
            <SkeletonLines count={6} />
          </div>
        ) : (data?.items.length ?? 0) === 0 ? (
          <EmptyState
            icon="employees"
            title={debounced || status || departmentId ? 'Nobody matched' : 'No employees yet'}
            body={
              debounced || status || departmentId
                ? 'Try a different search or clear the filters.'
                : 'People appear here once they are added. Everything else in the portal follows from an employee record.'
            }
          />
        ) : (
          data?.items.map((employee) => (
            <DataRow
              key={employee.id}
              leading={
                <Avatar initials={employee.initials} department={employee.department} size={32} />
              }
              title={employee.fullName}
              meta={[
                employee.employeeNumber,
                employee.designation,
                employee.department,
                employee.location,
                `joined ${formatDate(employee.dateOfJoining)}`,
                employee.manager ? `reports to ${employee.manager.fullName}` : 'no manager',
              ]
                .filter(Boolean)
                .join(' · ')}
              trailing={
                <>
                  {/* Whether they can sign in is a different question from
                      whether they are employed, and both matter to HR. */}
                  {!employee.hasPortalAccount ? (
                    <StatusChip label="No portal account" tone="gray" showDot={false} />
                  ) : null}
                  <StatusChip {...statusOf(employee.employmentStatus)} />
                </>
              }
            />
          ))
        )}
      </Card>
    </>
  );
}
