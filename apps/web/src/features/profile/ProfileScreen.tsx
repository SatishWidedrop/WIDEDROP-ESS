import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EMPTY_VALUE, formatDate } from '@widedrop/shared';
import { ApiError, api } from '../../lib/api.js';
import { queryKeys } from '../../lib/queryKeys.js';
import { statusOf } from '../../lib/status.js';
import { Avatar } from '../../components/ui/Avatar.js';
import { Button } from '../../components/ui/Button.js';
import { Card } from '../../components/ui/Card.js';
import { DataRow, Detail, DetailGrid } from '../../components/ui/DataRow.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ErrorState } from '../../components/ui/ErrorState.js';
import { Stack } from '../../components/ui/PageHeader.js';
import { SkeletonLines } from '../../components/ui/Skeleton.js';
import { StatusChip } from '../../components/ui/StatusChip.js';
import { TabPanel, Tabs } from '../../components/ui/Tabs.js';
import { useToast } from '../../components/ui/Toast.js';
import { FieldRow, FormError, TextField } from '../../components/form/Field.js';
import styles from './ProfileScreen.module.css';

interface Profile {
  id: string;
  employeeNumber: string;
  fullName: string;
  preferredName: string | null;
  initials: string;
  workEmail: string;
  workPhone: string | null;
  hasPhoto: boolean;
  dateOfJoining: string;
  probationEndDate: string | null;
  employmentStatus: string;
  manager: { id: string; fullName: string; initials: string } | null;
  employment: {
    type: string;
    noticePeriodDays: number;
    effectiveFrom: string;
    designation: string;
    grade: number | null;
    department: string;
    location: string;
    city: string;
    stateCode: string;
    costCentre: string | null;
  } | null;
  viewerIsSelf: boolean;
  personal: {
    dateOfBirth: string | null;
    gender: string;
    maritalStatus: string;
    bloodGroup: string;
    nationality: string | null;
    personalEmail: string | null;
    mobile: string | null;
    currentAddress: string | null;
    permanentAddress: string | null;
  } | null;
  statutoryIds: { id: string; kind: string; masked: string; verified: boolean }[];
  bankAccounts: {
    id: string;
    bankName: string;
    accountNumberMasked: string;
    ifscMasked: string;
    accountHolderName: string;
    isPrimary: boolean;
    verified: boolean;
  }[];
  emergencyContacts: {
    id: string;
    name: string;
    relationship: string;
    phoneMasked: string;
    isPrimary: boolean;
  }[];
}

const TABS = [
  { id: 'personal', label: 'Personal' },
  { id: 'employment', label: 'Employment' },
  { id: 'bank', label: 'Bank & statutory' },
  { id: 'emergency', label: 'Emergency' },
] as const;

export function ProfileScreen() {
  const [tab, setTab] = useState<string>('personal');
  const queryClient = useQueryClient();

  const profile = useQuery({
    queryKey: queryKeys.profile.detail('me'),
    queryFn: () => api.get<Profile>('/api/v1/profile'),
  });

  const changeRequests = useQuery({
    queryKey: queryKeys.profile.changeRequests,
    queryFn: () =>
      api.get<{
        items: {
          id: string;
          section: string;
          status: string;
          decisionNote: string | null;
          createdAt: string;
          ticketId: string | null;
        }[];
      }>('/api/v1/profile/change-requests'),
  });

  if (profile.error) {
    return <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />;
  }

  if (profile.isPending || !profile.data) {
    return (
      <Card>
        <SkeletonLines count={6} />
      </Card>
    );
  }

  const me = profile.data;
  const employment = me.employment;

  return (
    <>
      <div className={styles.identity}>
        <Avatar
          initials={me.initials}
          department={employment?.department}
          name={me.fullName}
          size={64}
        />
        <div className={styles.identityText}>
          <h1 className={styles.name}>{me.fullName}</h1>
          <p className={styles.role}>
            {[employment?.designation, employment?.department].filter(Boolean).join(' · ') ||
              'No current employment recorded'}
          </p>
          <div className={styles.chips}>
            <span className={styles.chip}>{me.employeeNumber}</span>
            {employment ? <span className={styles.chip}>{employment.location}</span> : null}
            {employment ? (
              <span className={styles.chip}>
                {employment.type.replace(/_/g, ' ').toLowerCase()}
              </span>
            ) : null}
            <span className={styles.chip}>Joined {formatDate(me.dateOfJoining)}</span>
          </div>
        </div>
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} label="Profile sections" />

      <TabPanel id="personal" active={tab}>
        <Stack>
          <Card title="Personal details" subtitle="Visible only to you and People Ops">
            {me.personal ? (
              <DetailGrid>
                <Detail
                  label="Date of birth"
                  value={me.personal.dateOfBirth ? formatDate(me.personal.dateOfBirth) : null}
                />
                <Detail label="Gender" value={readable(me.personal.gender)} />
                <Detail label="Marital status" value={readable(me.personal.maritalStatus)} />
                <Detail label="Blood group" value={readable(me.personal.bloodGroup)} />
                <Detail label="Personal email" value={me.personal.personalEmail} />
                <Detail label="Mobile" value={me.personal.mobile} />
                <Detail label="Current address" value={me.personal.currentAddress} />
                <Detail label="Permanent address" value={me.personal.permanentAddress} />
              </DetailGrid>
            ) : (
              <EmptyState
                compact
                icon="profile"
                title="No personal details recorded"
                body="People Ops fills these when you join. Ask them to add anything missing."
              />
            )}
          </Card>

          <ChangeRequestPanel
            requests={changeRequests.data?.items ?? []}
            onSubmitted={async () => {
              await queryClient.invalidateQueries({ queryKey: ['profile'] });
              await queryClient.invalidateQueries({ queryKey: ['help'] });
            }}
          />
        </Stack>
      </TabPanel>

      <TabPanel id="employment" active={tab}>
        <Card title="Employment">
          {employment ? (
            <DetailGrid>
              <Detail label="Designation" value={employment.designation} />
              <Detail label="Department" value={employment.department} />
              <Detail label="Location" value={`${employment.location}, ${employment.city}`} />
              <Detail label="Employment type" value={readable(employment.type)} />
              <Detail label="Effective from" value={formatDate(employment.effectiveFrom)} />
              <Detail label="Notice period" value={`${employment.noticePeriodDays} days`} />
              <Detail label="Cost centre" value={employment.costCentre} />
              <Detail label="Manager" value={me.manager?.fullName ?? null} />
              <Detail label="Status" value={statusOf(me.employmentStatus).label} />
              <Detail
                label="Probation ends"
                value={me.probationEndDate ? formatDate(me.probationEndDate) : null}
              />
            </DetailGrid>
          ) : (
            <EmptyState
              compact
              icon="profile"
              title="No current employment"
              body="An employment record is opened when you join and closed when you leave."
            />
          )}
        </Card>
      </TabPanel>

      <TabPanel id="bank" active={tab}>
        <Stack>
          <Card title="Bank accounts" subtitle="Payroll will not pay an unverified account" flush>
            {me.bankAccounts.length === 0 ? (
              <EmptyState
                compact
                icon="payslips"
                title="No bank account on file"
                body="Payroll cannot pay you without a verified account. Raise a change request and People Ops will add it."
              />
            ) : (
              me.bankAccounts.map((account) => (
                <DataRow
                  key={account.id}
                  title={account.bankName}
                  // Masked, even for its owner: the last four digits confirm
                  // which account it is, and the full number on a screen is
                  // one screenshot from being a problem.
                  meta={`${account.accountNumberMasked} · ${account.ifscMasked} · ${account.accountHolderName}`}
                  trailing={
                    <>
                      {account.isPrimary ? (
                        <StatusChip label="Primary" tone="blue" showDot={false} />
                      ) : null}
                      <StatusChip
                        label={account.verified ? 'Verified' : 'Not verified'}
                        tone={account.verified ? 'green' : 'amber'}
                      />
                    </>
                  }
                />
              ))
            )}
          </Card>

          <Card title="Statutory identifiers" flush>
            {me.statutoryIds.length === 0 ? (
              <EmptyState
                compact
                icon="profile"
                title="Nothing on file"
                body="PAN and UAN are required before payroll can run for you."
              />
            ) : (
              me.statutoryIds.map((identifier) => (
                <DataRow
                  key={identifier.id}
                  title={identifier.kind}
                  meta={identifier.masked}
                  trailing={
                    <StatusChip
                      label={identifier.verified ? 'Verified' : 'Not verified'}
                      tone={identifier.verified ? 'green' : 'amber'}
                    />
                  }
                />
              ))
            )}
          </Card>
        </Stack>
      </TabPanel>

      <TabPanel id="emergency" active={tab}>
        <EmergencyContacts
          contacts={me.emergencyContacts}
          onChanged={async () => {
            await queryClient.invalidateQueries({ queryKey: ['profile'] });
          }}
        />
      </TabPanel>
    </>
  );
}

function EmergencyContacts({
  contacts,
  onChanged,
}: {
  contacts: Profile['emergencyContacts'];
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      api.post('/api/v1/profile/emergency-contacts', {
        name: name.trim(),
        relationship: relationship.trim(),
        phone: phone.trim(),
        isPrimary: contacts.length === 0,
      }),
    onSuccess: async () => {
      setError(null);
      setName('');
      setRelationship('');
      setPhone('');
      toast.success('Contact added.');
      await onChanged();
    },
    onError: (failure: unknown) => {
      setError(failure instanceof ApiError ? failure.message : 'That contact could not be saved.');
    },
  });

  async function remove(id: string) {
    try {
      await api.delete(`/api/v1/profile/emergency-contacts/${id}`);
      toast.success('Contact removed.');
      await onChanged();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : 'That could not be removed.');
    }
  }

  return (
    <Stack>
      <Card title="Emergency contacts" subtitle="The one section you can change yourself" flush>
        {contacts.length === 0 ? (
          <EmptyState
            compact
            icon="profile"
            title="No emergency contact"
            body="Add someone we should call if something happens at work."
          />
        ) : (
          contacts.map((contact) => (
            <DataRow
              key={contact.id}
              title={contact.name}
              meta={`${contact.relationship} · ${contact.phoneMasked}`}
              trailing={
                <>
                  {contact.isPrimary ? (
                    <StatusChip label="Primary" tone="blue" showDot={false} />
                  ) : null}
                  <Button size="small" variant="ghost" onClick={() => void remove(contact.id)}>
                    Remove
                  </Button>
                </>
              }
            />
          ))
        )}
      </Card>

      <Card title="Add a contact">
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
        >
          <FieldRow>
            <TextField
              label="Name"
              value={name}
              maxLength={120}
              required
              onChange={(event) => setName(event.target.value)}
            />
            <TextField
              label="Relationship"
              value={relationship}
              maxLength={60}
              required
              placeholder="e.g. Spouse"
              onChange={(event) => setRelationship(event.target.value)}
            />
            <TextField
              label="Phone"
              value={phone}
              required
              placeholder="+919845012234"
              hint="International format, so it can be dialled from anywhere"
              onChange={(event) => setPhone(event.target.value)}
            />
          </FieldRow>

          <FormError message={error} />

          <Button
            type="submit"
            variant="primary"
            busy={add.isPending}
            disabled={!name.trim() || !relationship.trim() || !phone.trim()}
          >
            Add contact
          </Button>
        </form>
      </Card>
    </Stack>
  );
}

function ChangeRequestPanel({
  requests,
  onSubmitted,
}: {
  requests: {
    id: string;
    section: string;
    status: string;
    decisionNote: string | null;
    createdAt: string;
    ticketId: string | null;
  }[];
  onSubmitted: () => Promise<void>;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState('');
  const [personalEmail, setPersonalEmail] = useState('');
  const [currentAddress, setCurrentAddress] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () =>
      api.post<{ id: string; ticketId: string | null }>('/api/v1/profile/change-requests', {
        section: 'personal',
        changes: Object.fromEntries(
          Object.entries({ mobile, personalEmail, currentAddress }).filter(
            ([, value]) => value.trim().length > 0,
          ),
        ),
      }),
    onSuccess: async () => {
      setError(null);
      setOpen(false);
      setMobile('');
      setPersonalEmail('');
      setCurrentAddress('');
      toast.success('Requested. People Ops will verify it and a ticket tracks the progress.');
      await onSubmitted();
    },
    onError: (failure: unknown) => {
      setError(failure instanceof ApiError ? failure.message : 'That request could not be sent.');
    },
  });

  const anyFilled = [mobile, personalEmail, currentAddress].some(
    (value) => value.trim().length > 0,
  );

  return (
    <Card
      title="Change requests"
      subtitle="Everything but your emergency contacts is verified by People Ops before it changes"
      actions={
        <Button variant={open ? 'ghost' : 'secondary'} onClick={() => setOpen((value) => !value)}>
          {open ? 'Cancel' : 'Request a change'}
        </Button>
      }
    >
      {open ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            submit.mutate();
          }}
        >
          <TextField
            label="Mobile"
            optional
            value={mobile}
            placeholder="+919845012234"
            onChange={(event) => setMobile(event.target.value)}
          />
          <TextField
            label="Personal email"
            optional
            type="email"
            value={personalEmail}
            onChange={(event) => setPersonalEmail(event.target.value)}
          />
          <TextField
            label="Current address"
            optional
            value={currentAddress}
            maxLength={200}
            onChange={(event) => setCurrentAddress(event.target.value)}
          />

          <FormError message={error} />

          <Button type="submit" variant="primary" busy={submit.isPending} disabled={!anyFilled}>
            Send request
          </Button>
        </form>
      ) : requests.length === 0 ? (
        <EmptyState
          compact
          icon="profile"
          title="No change requests"
          body="Ask People Ops to correct anything that is wrong, and follow it here."
        />
      ) : (
        <div className={styles.requests}>
          {requests.map((request) => {
            const status = statusOf(request.status);
            return (
              <DataRow
                key={request.id}
                title={`${request.section.charAt(0).toUpperCase()}${request.section.slice(1)} details`}
                meta={[formatDate(request.createdAt.slice(0, 10)), request.decisionNote]
                  .filter(Boolean)
                  .join(' · ')}
                trailing={<StatusChip label={status.label} tone={status.tone} />}
              />
            );
          })}
        </div>
      )}
    </Card>
  );
}

/** `FULL_TIME_PERMANENT` → `Full time permanent`, and `UNDISCLOSED` → an em dash. */
function readable(value: string | null | undefined): string | null {
  if (!value || value === 'UNDISCLOSED' || value === 'UNKNOWN') return null;
  const words = value.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const NOT_RECORDED = EMPTY_VALUE;
