import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { buildTestApp, testEnv } from '../../test/app.js';
import { closeTestDb, resetTestDb, testDb } from '../../test/db.js';
import { buildFixture, rupees, type Fixture } from '../../test/fixtures.js';
import { hashPassword } from '../../lib/password.js';
import { resetStorage, storage } from '../../services/storage.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../../plugins/csrf.js';

/**
 * Uploading a bill.
 *
 * An upload is the one place where bytes somebody else chose reach this
 * system, so most of what follows is an attempt to get something past it: a
 * file that lies about its type, a file too large, a file on a claim that has
 * already been submitted, a file on somebody else's claim.
 *
 * What is asserted throughout is not only the status code but what ended up in
 * the database — the recorded content type is the sniffed one, the storage key
 * owes nothing to the filename, and the object is really there.
 */

const db = testDb();
const PASSWORD = 'the quiet mountain sings';
const ORIGIN = 'http://127.0.0.1:5173';

// Real magic bytes. A sniffer that trusted the extension would pass every
// test here; one that reads the bytes tells these apart.
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
  Buffer.alloc(64),
]);
const HTML = Buffer.from('<!doctype html><script>alert(document.cookie)</script>');

let app: App;
let fixture: Fixture;
let token: string;
/** The double-submit pair the CSRF plugin requires on every write. */
let csrf: string;
let root: string;
let addressCounter = 0;

/** A multipart body with one file part, built by hand so the parts are exact. */
function multipart(
  filename: string,
  contentType: string,
  body: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----widedroptest' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, body, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function draftClaim(employeeId: string): Promise<string> {
  const claim = await db.expenseClaim.create({
    data: {
      organizationId: fixture.organizationId,
      employeeId,
      reference: `EXP-${(addressCounter += 1).toString().padStart(4, '0')}`,
      title: 'Client dinner',
      spendDate: new Date('2026-09-01'),
      totalAmountMinor: rupees(1200),
      status: 'DRAFT',
    },
    select: { id: true },
  });
  return claim.id;
}

/**
 * The headers a real write carries.
 *
 * The CSRF plugin is left switched on for these tests — a suite that disabled
 * it would not be exercising the stack that ships — so every write sends the
 * origin, the token cookie and the matching header, exactly as the SPA does.
 */
const writeHeaders = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  origin: ORIGIN,
  cookie: `${CSRF_COOKIE}=${csrf}`,
  [CSRF_HEADER]: csrf,
  ...extra,
});

const upload = (claimId: string, file: ReturnType<typeof multipart>) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/expenses/${claimId}/attachments`,
    headers: writeHeaders(file.headers),
    payload: file.payload,
  });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ess-uploads-'));
  resetStorage();
  app = await buildTestApp({ STORAGE_LOCAL_PATH: root });
  await resetTestDb(db);
  fixture = await buildFixture();

  const env = testEnv();
  const email = 'priya.uploads@widedrop.test';
  await db.appUser.update({
    where: { id: fixture.users.priya },
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD, env.PASSWORD_PEPPER),
      passwordUpdatedAt: new Date(),
    },
  });
  // Personas come from these rows, so a role that does not exist cannot be
  // claimed by a token.
  const role = await db.role.create({
    data: { persona: 'EMPLOYEE', name: 'Employee', description: 'Their own records.' },
    select: { id: true },
  });
  await db.userRole.create({ data: { appUserId: fixture.users.priya, roleId: role.id } });

  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site' },
    payload: { email, password: PASSWORD },
  });
  expect(signIn.statusCode).toBe(200);
  token = signIn.json().accessToken;

  const issued = signIn.cookies.find((c) => c.name === CSRF_COOKIE);
  expect(issued, 'sign-in must issue a CSRF token').toBeDefined();
  csrf = issued!.value;
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
  resetStorage();
});

describe('POST /expenses/:id/attachments', () => {
  it('stores a PDF and records what the bytes actually are', async () => {
    const claimId = await draftClaim(fixture.people.priya);
    const response = await upload(claimId, multipart('dinner.pdf', 'application/pdf', PDF));

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      filename: 'dinner.pdf',
      contentType: 'application/pdf',
      sizeBytes: PDF.byteLength,
    });

    const stored = await db.expenseAttachment.findFirstOrThrow({
      where: { expenseClaimId: claimId },
      select: { file: true },
    });
    expect(stored.file.purpose).toBe('EXPENSE_BILL');
    expect(stored.file.contentType).toBe('application/pdf');
    expect(stored.file.subjectEmployeeId).toBe(fixture.people.priya);
    // No scanner is wired up, and the row says so rather than claiming a
    // scan is pending.
    expect(stored.file.scanStatus).toBe('SKIPPED');

    // The key owes nothing to the filename.
    expect(stored.file.storageKey).not.toContain('dinner');
    expect(stored.file.storageKey).toMatch(/^EXPENSE_BILL\/\d{4}\/\d{2}\/[\w-]+\/[\w-]+\.pdf$/);

    // And the bytes are really there.
    expect(await storage(app.env).exists(stored.file.storageKey)).toBe(true);
  });

  it('refuses an HTML file wearing a .pdf name', async () => {
    const claimId = await draftClaim(fixture.people.priya);
    const response = await upload(claimId, multipart('invoice.pdf', 'application/pdf', HTML));

    // This is the case the whole sniffing step exists for: served back later
    // as a PDF it would execute instead, and on the API's own origin.
    expect(response.statusCode).toBe(400);
    expect(await db.expenseAttachment.count({ where: { expenseClaimId: claimId } })).toBe(0);
  });

  it('refuses a PNG declared as a PDF', async () => {
    const claimId = await draftClaim(fixture.people.priya);
    const response = await upload(claimId, multipart('bill.pdf', 'application/pdf', PNG));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('image/png');
  });

  it('refuses a PNG whose name claims to be a JPEG', async () => {
    const claimId = await draftClaim(fixture.people.priya);
    const response = await upload(claimId, multipart('bill.jpg', 'image/png', PNG));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('.png');
  });

  it('refuses an empty file', async () => {
    const claimId = await draftClaim(fixture.people.priya);
    const response = await upload(
      claimId,
      multipart('nothing.pdf', 'application/pdf', Buffer.alloc(0)),
    );

    expect(response.statusCode).toBe(400);
  });

  it('refuses a file over the size limit', async () => {
    const claimId = await draftClaim(fixture.people.priya);
    const oversize = Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)]);
    const response = await upload(claimId, multipart('huge.pdf', 'application/pdf', oversize));

    expect([400, 413]).toContain(response.statusCode);
    expect(await db.expenseAttachment.count({ where: { expenseClaimId: claimId } })).toBe(0);
  });

  it('refuses a bill on a claim that has been submitted', async () => {
    const claimId = await draftClaim(fixture.people.priya);
    await db.expenseClaim.update({ where: { id: claimId }, data: { status: 'PENDING_MANAGER' } });

    const response = await upload(claimId, multipart('late.pdf', 'application/pdf', PDF));

    // The thing the manager approved and the thing on file have to stay the
    // same thing.
    expect(response.statusCode).toBe(409);
  });

  it("answers 404, not 403, for somebody else's claim", async () => {
    const claimId = await draftClaim(fixture.people.divya);
    const response = await upload(claimId, multipart('theirs.pdf', 'application/pdf', PDF));

    // A 403 would confirm the reference exists.
    expect(response.statusCode).toBe(404);
  });

  it('caps how many bills one claim can carry', async () => {
    const claimId = await draftClaim(fixture.people.priya);
    for (let i = 0; i < 5; i += 1) {
      expect(
        (await upload(claimId, multipart(`b${i}.pdf`, 'application/pdf', PDF))).statusCode,
      ).toBe(201);
    }
    const sixth = await upload(claimId, multipart('b5.pdf', 'application/pdf', PDF));
    expect(sixth.statusCode).toBe(400);
  });

  it('records the upload in the audit trail', async () => {
    const claimId = await draftClaim(fixture.people.priya);
    await upload(claimId, multipart('audited.pdf', 'application/pdf', PDF));

    const events = await db.auditEvent.findMany({
      where: { entityType: 'ExpenseClaim', entityId: claimId },
      select: { action: true, summary: true },
    });
    expect(events.some((e) => e.summary?.includes('audited.pdf'))).toBe(true);
  });
});

describe('GET /expenses/:id/attachments', () => {
  it('lists what is attached, with no URLs in it', async () => {
    const claimId = await draftClaim(fixture.people.priya);
    await upload(claimId, multipart('first.pdf', 'application/pdf', PDF));
    await upload(claimId, multipart('second.png', 'image/png', PNG));

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/expenses/${claimId}/attachments`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const { items } = response.json();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ filename: 'first.pdf', contentType: 'application/pdf' });
    expect(items[1]).toMatchObject({ filename: 'second.png', contentType: 'image/png' });

    // A signed URL is a capability, so it is issued one file at a time when
    // somebody is about to open it — never handed out with a list.
    for (const item of items) {
      expect(Object.keys(item)).not.toContain('url');
      expect(JSON.stringify(item)).not.toContain('signature');
    }
  });

  it("answers 404 for a claim outside the caller's scope", async () => {
    const claimId = await draftClaim(fixture.people.divya);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/expenses/${claimId}/attachments`,
      headers: { authorization: `Bearer ${token}` },
    });

    // Not an empty list: that would be indistinguishable from a claim of
    // their own with nothing attached.
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /expenses/:id/attachments/:attachmentId', () => {
  it('hands back a short-lived URL for your own bill', async () => {
    const claimId = await draftClaim(fixture.people.priya);
    const created = await upload(claimId, multipart('mine.pdf', 'application/pdf', PDF));
    const attachmentId = created.json().id;

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/expenses/${claimId}/attachments/${attachmentId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const { url, expiresAt } = response.json();
    expect(url).toContain('/api/v1/files/download');
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    // And the URL actually works, which is the half that was missing before.
    const parsed = new URL(url);
    const download = await app.inject({ method: 'GET', url: parsed.pathname + parsed.search });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(PDF)).toBe(true);
  });

  it("will not hand back a URL for somebody else's bill", async () => {
    const claimId = await draftClaim(fixture.people.divya);
    const attachment = await db.expenseAttachment.create({
      data: {
        organizationId: fixture.organizationId,
        expenseClaimId: claimId,
        fileObjectId: (
          await db.fileObject.create({
            data: {
              organizationId: fixture.organizationId,
              purpose: 'EXPENSE_BILL',
              storageKey: 'EXPENSE_BILL/2026/09/other/other.pdf',
              displayFilename: 'other.pdf',
              contentType: 'application/pdf',
              sizeBytes: 10,
              sha256: 'a'.repeat(64),
              scanStatus: 'SKIPPED',
            },
            select: { id: true },
          })
        ).id,
      },
      select: { id: true },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/expenses/${claimId}/attachments/${attachment.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    // Priya holds expense:read at SELF only.
    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /expenses/:id/attachments/:attachmentId', () => {
  it('detaches a bill from a draft, keeping the file itself', async () => {
    const claimId = await draftClaim(fixture.people.priya);
    const created = await upload(claimId, multipart('remove-me.pdf', 'application/pdf', PDF));
    const attachmentId = created.json().id;

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/expenses/${claimId}/attachments/${attachmentId}`,
      headers: writeHeaders(),
    });

    expect(response.statusCode).toBe(204);
    expect(await db.expenseAttachment.count({ where: { id: attachmentId } })).toBe(0);
    // Detaching a bill is not a reason to destroy evidence; the retention
    // sweep is what removes a file nothing references.
    expect(await db.fileObject.count({ where: { displayFilename: 'remove-me.pdf' } })).toBe(1);
  });

  it('will not detach a bill once the claim has been submitted', async () => {
    const claimId = await draftClaim(fixture.people.priya);
    const created = await upload(claimId, multipart('locked.pdf', 'application/pdf', PDF));
    await db.expenseClaim.update({ where: { id: claimId }, data: { status: 'PENDING_MANAGER' } });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/expenses/${claimId}/attachments/${created.json().id}`,
      headers: writeHeaders(),
    });

    expect(response.statusCode).toBe(409);
  });
});
