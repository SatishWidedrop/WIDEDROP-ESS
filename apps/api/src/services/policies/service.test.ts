import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runWithContext } from '../../lib/request-context.js';
import { closeTestDb, resetTestDb, testDb } from '../../test/db.js';
import { buildFixture, HMAC_KEY, type Fixture } from '../../test/fixtures.js';
import { acknowledgePolicyVersion, publishPolicyVersion } from './service.js';

const db = testDb();
let fixture: Fixture;

beforeAll(async () => {
  await resetTestDb(db);
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  fixture = await buildFixture();
});

async function as<T>(
  principal: { userId: string; organizationId: string; employeeId?: string | undefined },
  fn: () => Promise<T>,
): Promise<T> {
  return runWithContext(
    {
      requestId: 'test',
      startedAt: Date.now(),
      userId: principal.userId,
      organizationId: principal.organizationId,
      employeeId: principal.employeeId,
      personas: ['HR'],
      ip: '203.0.113.10',
    },
    fn,
  );
}

/** A draft version of a policy, with the applicability rule it will be published under. */
async function draftVersion(options: {
  versionNumber?: number;
  policyId?: string;
  dimension?: 'ALL' | 'DEPARTMENT';
  dueDays?: number | null;
}): Promise<{ policyId: string; versionId: string }> {
  const policyId =
    options.policyId ??
    (
      await db.policy.create({
        data: {
          organizationId: fixture.organizationId,
          code: `POL-${Math.random().toString(36).slice(2, 8)}`,
          name: 'Information security',
          ownerTeam: 'IT & Security',
          status: 'DRAFT',
        },
        select: { id: true },
      })
    ).id;

  const version = await db.policyVersion.create({
    data: {
      organizationId: fixture.organizationId,
      policyId,
      versionLabel: `v${options.versionNumber ?? 1}.0`,
      versionNumber: options.versionNumber ?? 1,
      status: 'DRAFT',
      summary: 'How we handle company and customer data.',
      body: 'The full text of the policy.',
      effectiveFrom: new Date('2026-09-01'),
      acknowledgementDueDays: options.dueDays === undefined ? 14 : options.dueDays,
      requiresAcknowledgement: true,
      applicability: {
        create: [
          options.dimension === 'DEPARTMENT'
            ? {
                organizationId: fixture.organizationId,
                dimension: 'DEPARTMENT',
                targetId: fixture.departmentId,
              }
            : { organizationId: fixture.organizationId, dimension: 'ALL' },
        ],
      },
    },
    select: { id: true },
  });

  return { policyId, versionId: version.id };
}

describe('publishPolicyVersion', () => {
  it('resolves the audience into assignment and acknowledgement rows', async () => {
    const { versionId } = await draftVersion({});

    const result = await as(fixture.principals.hr, () =>
      db.$transaction((tx) =>
        publishPolicyVersion(tx, fixture.principals.hr, { policyVersionId: versionId }, HMAC_KEY),
      ),
    );

    // Four employees exist in the fixture, all active.
    expect(result.assigned).toBe(4);

    const assignments = await db.policyAssignment.count({ where: { policyVersionId: versionId } });
    const acknowledgements = await db.policyAcknowledgement.findMany({
      where: { policyVersionId: versionId },
      select: { status: true, dueOn: true },
    });

    expect(assignments).toBe(4);
    expect(acknowledgements).toHaveLength(4);
    expect(acknowledgements.every((row) => row.status === 'PENDING')).toBe(true);
    // 14 days after publication, and publication is after the effective date.
    expect(acknowledgements.every((row) => row.dueOn !== null)).toBe(true);
  });

  it('refuses to publish a version that applies to nobody', async () => {
    const policy = await db.policy.create({
      data: {
        organizationId: fixture.organizationId,
        code: 'POL-EMPTY',
        name: 'Unassigned policy',
        ownerTeam: 'People Ops',
        status: 'DRAFT',
      },
      select: { id: true },
    });
    const version = await db.policyVersion.create({
      data: {
        organizationId: fixture.organizationId,
        policyId: policy.id,
        versionLabel: 'v1.0',
        versionNumber: 1,
        status: 'DRAFT',
        summary: 'No applicability rule.',
        body: 'Text.',
        effectiveFrom: new Date('2026-09-01'),
      },
      select: { id: true },
    });

    await expect(
      as(fixture.principals.hr, () =>
        db.$transaction((tx) =>
          publishPolicyVersion(
            tx,
            fixture.principals.hr,
            { policyVersionId: version.id },
            HMAC_KEY,
          ),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('supersedes the previous published version rather than leaving two current', async () => {
    const first = await draftVersion({});
    await as(fixture.principals.hr, () =>
      db.$transaction((tx) =>
        publishPolicyVersion(
          tx,
          fixture.principals.hr,
          { policyVersionId: first.versionId },
          HMAC_KEY,
        ),
      ),
    );

    const second = await draftVersion({ policyId: first.policyId, versionNumber: 2 });
    const result = await as(fixture.principals.hr, () =>
      db.$transaction((tx) =>
        publishPolicyVersion(
          tx,
          fixture.principals.hr,
          { policyVersionId: second.versionId },
          HMAC_KEY,
        ),
      ),
    );

    expect(result.supersededVersionId).toBe(first.versionId);

    const published = await db.policyVersion.count({
      where: { policyId: first.policyId, status: 'PUBLISHED' },
    });
    expect(published).toBe(1);

    const old = await db.policyVersion.findUniqueOrThrow({
      where: { id: first.versionId },
      select: { status: true, supersededByVersionId: true },
    });
    expect(old.status).toBe('SUPERSEDED');
    expect(old.supersededByVersionId).toBe(second.versionId);
  });
});

describe('acknowledgePolicyVersion', () => {
  async function publishToAll(): Promise<string> {
    const { versionId } = await draftVersion({});
    await as(fixture.principals.hr, () =>
      db.$transaction((tx) =>
        publishPolicyVersion(tx, fixture.principals.hr, { policyVersionId: versionId }, HMAC_KEY),
      ),
    );
    return versionId;
  }

  it('stores employee, version, status and timestamp, with the evidence', async () => {
    const versionId = await publishToAll();

    const { acknowledgedAt } = await as(fixture.principals.employee, () =>
      db.$transaction((tx) =>
        acknowledgePolicyVersion(
          tx,
          fixture.principals.employee,
          {
            policyVersionId: versionId,
            ip: '203.0.113.42',
            userAgent: 'Mozilla/5.0 (test)',
          },
          HMAC_KEY,
        ),
      ),
    );

    const row = await db.policyAcknowledgement.findUniqueOrThrow({
      where: {
        policyVersionId_employeeId: {
          policyVersionId: versionId,
          employeeId: fixture.people.priya,
        },
      },
      select: {
        employeeId: true,
        policyVersionId: true,
        status: true,
        acknowledgedAt: true,
        acknowledgedIp: true,
        acknowledgedUserAgent: true,
      },
    });

    expect(row).toMatchObject({
      employeeId: fixture.people.priya,
      policyVersionId: versionId,
      status: 'ACKNOWLEDGED',
      acknowledgedIp: '203.0.113.42',
      acknowledgedUserAgent: 'Mozilla/5.0 (test)',
    });
    expect(row.acknowledgedAt?.toISOString()).toBe(acknowledgedAt.toISOString());
  });

  it('writes an ACKNOWLEDGE audit row', async () => {
    const versionId = await publishToAll();

    await as(fixture.principals.employee, () =>
      db.$transaction((tx) =>
        acknowledgePolicyVersion(
          tx,
          fixture.principals.employee,
          { policyVersionId: versionId },
          HMAC_KEY,
        ),
      ),
    );

    const audit = await db.auditEvent.findFirstOrThrow({
      where: { entityType: 'policy_acknowledgement', action: 'ACKNOWLEDGE' },
      select: { toState: true, summary: true },
    });
    expect(audit.toState).toBe('ACKNOWLEDGED');
    expect(audit.summary).toContain('v1.0');
  });

  it('keeps the original timestamp when acknowledged twice', async () => {
    const versionId = await publishToAll();

    const first = await as(fixture.principals.employee, () =>
      db.$transaction((tx) =>
        acknowledgePolicyVersion(
          tx,
          fixture.principals.employee,
          { policyVersionId: versionId },
          HMAC_KEY,
        ),
      ),
    );

    const second = await as(fixture.principals.employee, () =>
      db.$transaction((tx) =>
        acknowledgePolicyVersion(
          tx,
          fixture.principals.employee,
          { policyVersionId: versionId },
          HMAC_KEY,
        ),
      ),
    );

    expect(second.acknowledgedAt.toISOString()).toBe(first.acknowledgedAt.toISOString());
  });

  it('refuses to acknowledge a superseded version', async () => {
    const first = await draftVersion({});
    await as(fixture.principals.hr, () =>
      db.$transaction((tx) =>
        publishPolicyVersion(
          tx,
          fixture.principals.hr,
          { policyVersionId: first.versionId },
          HMAC_KEY,
        ),
      ),
    );

    const second = await draftVersion({ policyId: first.policyId, versionNumber: 2 });
    await as(fixture.principals.hr, () =>
      db.$transaction((tx) =>
        publishPolicyVersion(
          tx,
          fixture.principals.hr,
          { policyVersionId: second.versionId },
          HMAC_KEY,
        ),
      ),
    );

    await expect(
      as(fixture.principals.employee, () =>
        db.$transaction((tx) =>
          acknowledgePolicyVersion(
            tx,
            fixture.principals.employee,
            { policyVersionId: first.versionId },
            HMAC_KEY,
          ),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: 'POLICY_VERSION_SUPERSEDED' });
  });

  it('refuses when the policy was never assigned to this person', async () => {
    // Published to the Platform department only; Divya is in it, so narrow the
    // audience to a department nobody belongs to instead.
    const otherDepartment = await db.department.create({
      data: { organizationId: fixture.organizationId, code: 'LEGAL', name: 'Legal' },
      select: { id: true },
    });

    const policy = await db.policy.create({
      data: {
        organizationId: fixture.organizationId,
        code: 'POL-LEGAL',
        name: 'Outside counsel policy',
        ownerTeam: 'Legal',
        status: 'DRAFT',
      },
      select: { id: true },
    });
    const version = await db.policyVersion.create({
      data: {
        organizationId: fixture.organizationId,
        policyId: policy.id,
        versionLabel: 'v1.0',
        versionNumber: 1,
        status: 'PUBLISHED',
        summary: 'Applies to Legal only.',
        body: 'Text.',
        effectiveFrom: new Date('2026-09-01'),
        publishedAt: new Date('2026-09-01'),
        // The schema insists a published version names who published it.
        publishedByUserId: fixture.principals.hr.userId,
        applicability: {
          create: [
            {
              organizationId: fixture.organizationId,
              dimension: 'DEPARTMENT',
              targetId: otherDepartment.id,
            },
          ],
        },
      },
      select: { id: true },
    });

    await expect(
      as(fixture.principals.employee, () =>
        db.$transaction((tx) =>
          acknowledgePolicyVersion(
            tx,
            fixture.principals.employee,
            { policyVersionId: version.id },
            HMAC_KEY,
          ),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
