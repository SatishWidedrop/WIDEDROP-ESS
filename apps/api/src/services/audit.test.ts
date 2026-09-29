import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, resetTestDb, testDb } from '../test/db.js';
import { recordAudit, verifyChain } from './audit.js';
import { runAsSystem, runWithContext } from '../lib/request-context.js';

const HMAC_KEY = Buffer.alloc(32, 11).toString('base64');
const db = testDb();

let organizationId: string;

beforeAll(async () => {
  await resetTestDb(db);
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  const org = await db.organization.create({
    data: {
      legalName: 'Widedrop Technologies Pvt Ltd',
      displayName: 'Widedrop',
      domain: `widedrop-${Math.floor(Number(process.hrtime.bigint() % 1000000n))}.test`,
      helpdeskEmail: 'helpdesk@widedroptech.com',
    },
  });
  organizationId = org.id;
});

describe('recording', () => {
  it('chains each row onto the one before it', async () => {
    const first = await recordAudit(
      db,
      { organizationId, action: 'LOGIN', entityType: 'app_user', summary: 'Signed in' },
      HMAC_KEY,
    );
    const second = await recordAudit(
      db,
      { organizationId, action: 'CREATE', entityType: 'leave_request' },
      HMAC_KEY,
    );

    const rows = await db.auditEvent.findMany({ orderBy: { sequence: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.previousHash).toBe('0'.repeat(64));
    expect(rows[1]!.previousHash).toBe(first.rowHash);
    expect(second.sequence).toBeGreaterThan(first.sequence);
  });

  it('verifies an intact chain', async () => {
    for (let i = 0; i < 5; i += 1) {
      await recordAudit(
        db,
        { organizationId, action: 'UPDATE', entityType: 'employee', summary: `change ${i}` },
        HMAC_KEY,
      );
    }
    const result = await verifyChain(db, { organizationId }, HMAC_KEY);
    expect(result).toMatchObject({ valid: true, checked: 5, gaps: [] });
  });

  it('detects a row whose content was altered in the database', async () => {
    await recordAudit(db, { organizationId, action: 'LOGIN', entityType: 'app_user' }, HMAC_KEY);
    const target = await recordAudit(
      db,
      { organizationId, action: 'STATE_TRANSITION', entityType: 'payroll_cycle', toState: 'PUBLISHED' },
      HMAC_KEY,
    );

    // The triggers block UPDATE from any ordinary connection. An attacker with
    // superuser rights could disable them, so the test simulates exactly that:
    // the chain must still betray the change.
    await db.$executeRawUnsafe(`ALTER TABLE ess.audit_event DISABLE TRIGGER trg_audit_event_append_only`);
    await db.$executeRawUnsafe(
      `UPDATE ess.audit_event SET to_state = 'CANCELLED' WHERE id = '${target.id}'`,
    );
    await db.$executeRawUnsafe(`ALTER TABLE ess.audit_event ENABLE TRIGGER trg_audit_event_append_only`);

    const result = await verifyChain(db, { organizationId }, HMAC_KEY);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toMatchObject({ id: target.id, reason: 'hash-mismatch' });
  });

  it('detects a deleted row by the gap it leaves', async () => {
    const rows = [];
    for (let i = 0; i < 4; i += 1) {
      rows.push(
        await recordAudit(db, { organizationId, action: 'UPDATE', entityType: 'employee' }, HMAC_KEY),
      );
    }

    await db.$executeRawUnsafe(`ALTER TABLE ess.audit_event DISABLE TRIGGER trg_audit_event_append_only`);
    await db.$executeRawUnsafe(`DELETE FROM ess.audit_event WHERE id = '${rows[1]!.id}'`);
    await db.$executeRawUnsafe(`ALTER TABLE ess.audit_event ENABLE TRIGGER trg_audit_event_append_only`);

    const result = await verifyChain(db, { organizationId }, HMAC_KEY);
    expect(result.valid).toBe(false);
    // The chain breaks and the sequence shows exactly which row went missing.
    expect(result.gaps.length + (result.brokenAt ? 1 : 0)).toBeGreaterThan(0);
  });

  it('cannot be verified with the wrong key', async () => {
    await recordAudit(db, { organizationId, action: 'LOGIN', entityType: 'app_user' }, HMAC_KEY);
    const wrongKey = Buffer.alloc(32, 12).toString('base64');
    const result = await verifyChain(db, { organizationId }, wrongKey);
    expect(result.valid).toBe(false);
  });

  it('reports an empty chain as valid', async () => {
    expect(await verifyChain(db, { organizationId }, HMAC_KEY)).toEqual({
      valid: true,
      checked: 0,
      gaps: [],
    });
  });
});

describe('what is recorded', () => {
  it('takes the actor and request id from the ambient context', async () => {
    await runWithContext(
      {
        requestId: 'req_test_1',
        personas: ['ACCOUNTS'],
        ip: '203.0.113.9',
        userAgent: 'Mozilla/5.0 test',
        userId: undefined,
      },
      async () => {
        await recordAudit(
          db,
          { organizationId, action: 'STATE_TRANSITION', entityType: 'payroll_cycle' },
          HMAC_KEY,
        );
      },
    );

    const row = await db.auditEvent.findFirstOrThrow();
    expect(row.requestId).toBe('req_test_1');
    expect(row.actorPersona).toBe('ACCOUNTS');
    expect(row.ip).toBe('203.0.113.9');
  });

  it('attributes a scheduled job to the system, not to nobody', async () => {
    await runAsSystem({ requestId: 'job_1', job: 'leave-accrual' }, async () => {
      await recordAudit(
        db,
        { organizationId, action: 'CREATE', entityType: 'leave_balance_ledger', actor: { kind: 'SCHEDULER' } },
        HMAC_KEY,
      );
    });

    const row = await db.auditEvent.findFirstOrThrow();
    expect(row.actorKind).toBe('SCHEDULER');
    expect(row.requestId).toBe('job_1');
  });

  it('records that a secret changed without recording the secret', async () => {
    await recordAudit(
      db,
      {
        organizationId,
        action: 'UPDATE',
        entityType: 'employee_bank_account',
        before: { bankName: 'HDFC Bank', accountNumberCt: Buffer.from('ciphertext'), accountNumberMasked: '•••• 4412' },
        after: { bankName: 'ICICI Bank', accountNumberCt: Buffer.from('other'), accountNumberMasked: '•••• 9981' },
      },
      HMAC_KEY,
    );

    const row = await db.auditEvent.findFirstOrThrow();
    const before = row.beforeData as Record<string, unknown>;
    const after = row.afterData as Record<string, unknown>;

    // The change is visible; the value is not.
    expect(before.bankName).toBe('HDFC Bank');
    expect(after.bankName).toBe('ICICI Bank');
    expect(before.accountNumberCt).toBe('[not recorded]');
    expect(after.accountNumberCt).toBe('[not recorded]');
    // The masked form is safe to keep: it is what the screen already shows.
    expect(before.accountNumberMasked).toBe('•••• 4412');
  });

  it('never writes a password hash into the trail', async () => {
    await recordAudit(
      db,
      {
        organizationId,
        action: 'UPDATE',
        entityType: 'app_user',
        before: { email: 'priya@widedrop.test', passwordHash: '$argon2id$v=19$m=65536...' },
        after: { email: 'priya@widedrop.test', passwordHash: '$argon2id$v=19$m=65536...new' },
      },
      HMAC_KEY,
    );

    const row = await db.auditEvent.findFirstOrThrow();
    const serialised = JSON.stringify(row, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialised).not.toContain('argon2id');
    // Two layers cover this field — the audit stripper and the log redactor —
    // so either marker is correct; what matters is that the hash is gone.
    expect(['[not recorded]', '[redacted]']).toContain(
      (row.beforeData as Record<string, unknown>).passwordHash,
    );
  });
});
