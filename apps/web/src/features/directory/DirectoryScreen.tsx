import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { Avatar } from '../../components/ui/Avatar.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow, Detail, DetailGrid } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { PageHeader, SplitLayout } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { SelectField, TextField } from '../../components/form/Field.js';
import styles from './DirectoryScreen.module.css';

interface DirectoryEntry {
  id: string;
  fullName: string;
  initials: string;
  employeeNumber: string;
  workEmail: string;
  workPhone: string | null;
  hasPhoto: boolean;
  designation: string | null;
  department: string | null;
  location: string | null;
}

interface DirectoryResponse {
  items: DirectoryEntry[];
  departments: { id: string; name: string }[];
  locations: { id: string; name: string; city: string }[];
  total: number;
}

interface PersonDetail extends DirectoryEntry {
  city: string | null;
  timezone: string | null;
  manager: { id: string; fullName: string; initials: string; designation: string | null } | null;
  reports: { id: string; fullName: string; initials: string; designation: string | null }[];
}

export function DirectoryScreen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('person'));

  // Debounced so a search is one request per pause, not one per keystroke.
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const list = useQuery({
    queryKey: queryKeys.directory.search(`${debounced}|${departmentId}`),
    queryFn: () =>
      api.get<DirectoryResponse>('/api/v1/directory', {
        query: { q: debounced || undefined, departmentId: departmentId || undefined },
      }),
  });

  const person = useQuery({
    queryKey: queryKeys.directory.person(selectedId ?? ''),
    queryFn: () => api.get<PersonDetail>(`/api/v1/directory/${selectedId}`),
    enabled: selectedId !== null,
  });

  if (list.error) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;

  const items = list.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Directory"
        subtitle={
          list.data
            ? `${items.length} of ${list.data.total} ${list.data.total === 1 ? 'person' : 'people'}`
            : 'Find colleagues across Widedrop'
        }
        actions={
          <div className={styles.filters}>
            <TextField
              label="Search"
              type="search"
              value={query}
              placeholder="Name, email or employee number"
              onChange={(event) => setQuery(event.target.value)}
            />
            <SelectField
              label="Department"
              value={departmentId}
              onChange={(event) => setDepartmentId(event.target.value)}
            >
              <option value="">All departments</option>
              {list.data?.departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </SelectField>
          </div>
        }
      />

      <SplitLayout>
        <Card flush>
          {list.isPending ? (
            <div className={styles.padded}>
              <SkeletonLines count={6} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              compact
              icon="directory"
              title={debounced ? 'Nobody matched' : 'Nobody listed yet'}
              body={
                debounced
                  ? 'Try a different name, email or employee number.'
                  : 'People appear here once People Ops adds them and they choose to be listed.'
              }
            />
          ) : (
            items.map((entry) => (
              <DataRow
                key={entry.id}
                leading={
                  <Avatar initials={entry.initials} department={entry.department} size={32} />
                }
                title={entry.fullName}
                meta={[entry.designation, entry.department].filter(Boolean).join(' · ')}
                selected={entry.id === selectedId}
                onClick={() => {
                  setSelectedId(entry.id);
                  setSearchParams({ person: entry.id }, { replace: true });
                }}
              />
            ))
          )}
        </Card>

        {selectedId === null ? (
          <Card>
            <EmptyState
              icon="directory"
              title="Nobody selected"
              body="Choose a colleague to see their work contact details and reporting line."
            />
          </Card>
        ) : person.error ? (
          <ErrorState error={person.error} onRetry={() => void person.refetch()} />
        ) : person.isPending || !person.data ? (
          <Card>
            <SkeletonLines count={5} />
          </Card>
        ) : (
          <PersonCard person={person.data} onSelect={setSelectedId} />
        )}
      </SplitLayout>
    </>
  );
}

function PersonCard({
  person,
  onSelect,
}: {
  person: PersonDetail;
  onSelect: (id: string) => void;
}) {
  return (
    <Card>
      <div className={styles.person}>
        <Avatar
          initials={person.initials}
          department={person.department}
          name={person.fullName}
          size={56}
        />
        <div>
          <h2 className={styles.personName}>{person.fullName}</h2>
          <p className={styles.personRole}>
            {[person.designation, person.department, person.location].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>

      {/*
        Work contact details only. The directory is readable by everyone, so
        it carries nothing that is not already on a business card.
      */}
      <DetailGrid>
        <Detail label="Employee number" value={person.employeeNumber} />
        <Detail label="Work email" value={person.workEmail} />
        <Detail label="Work phone" value={person.workPhone} />
        <Detail label="Location" value={person.city} />
      </DetailGrid>

      <div className={styles.reporting}>
        <div className={styles.reportingHeading}>Reporting line</div>

        {person.manager ? (
          <button
            type="button"
            className={styles.personLink}
            onClick={() => onSelect(person.manager!.id)}
          >
            <Avatar initials={person.manager.initials} size={28} />
            <span>
              <span className={styles.linkName}>{person.manager.fullName}</span>
              <span className={styles.linkMeta}>Manager · {person.manager.designation ?? '—'}</span>
            </span>
          </button>
        ) : (
          <p className={styles.none}>No manager recorded.</p>
        )}

        {person.reports.length > 0 ? (
          <div className={styles.reports}>
            {person.reports.map((report) => (
              <button
                key={report.id}
                type="button"
                className={styles.personLink}
                onClick={() => onSelect(report.id)}
              >
                <Avatar initials={report.initials} size={28} />
                <span>
                  <span className={styles.linkName}>{report.fullName}</span>
                  <span className={styles.linkMeta}>{report.designation ?? '—'}</span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
