import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesystemStorage } from './filesystem.js';
import { buildStorageKey } from './types.js';

const SIGNING_KEY = Buffer.alloc(32, 3).toString('base64');

describe('buildStorageKey', () => {
  const date = new Date(Date.UTC(2026, 8, 29));

  it('namespaces by purpose and date so lifecycle rules can act on it', () => {
    expect(
      buildStorageKey({
        purpose: 'PAYSLIP_PDF',
        scopeId: 'emp_123',
        objectId: 'obj_abc',
        extension: 'pdf',
        date,
      }),
    ).toBe('PAYSLIP_PDF/2026/09/emp_123/obj_abc.pdf');
  });

  it('strips anything that could escape the namespace', () => {
    const key = buildStorageKey({
      purpose: '../../etc',
      scopeId: '../../..',
      objectId: 'a/b',
      extension: '../sh',
      date,
    });
    expect(key).not.toContain('..');
    expect(key).toBe('etc/2026/09//ab.sh');
  });

  it('normalises the extension', () => {
    const key = buildStorageKey({
      purpose: 'EXPENSE_BILL',
      scopeId: 'e1',
      objectId: 'o1',
      extension: '.PDF',
      date,
    });
    expect(key.endsWith('.pdf')).toBe(true);
  });
});

describe('FilesystemStorage', () => {
  let root: string;
  let storage: FilesystemStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ess-storage-'));
    storage = new FilesystemStorage({
      root,
      signingKey: SIGNING_KEY,
      apiBaseUrl: 'https://api.ess.widedrop.com',
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores and reads an object, reporting its digest', async () => {
    const body = Buffer.from('%PDF-1.7 payslip');
    const stored = await storage.put({
      key: 'PAYSLIP_PDF/2026/09/emp_1/obj_1.pdf',
      body,
      contentType: 'application/pdf',
    });

    expect(stored.size).toBe(body.byteLength);
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await storage.exists(stored.key)).toBe(true);

    const read = await storage.get(stored.key);
    const chunks: Buffer[] = [];
    for await (const chunk of read.body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('%PDF-1.7 payslip');
  });

  it('writes files that only the service account can read', async () => {
    await storage.put({ key: 'a/b.pdf', body: Buffer.from('x'), contentType: 'application/pdf' });
    const { mode } = await import('node:fs/promises').then((fs) => fs.stat(join(root, 'a/b.pdf')));
    expect(mode & 0o077).toBe(0);
  });

  it('refuses a key that escapes or sidesteps the storage root', async () => {
    for (const key of [
      '../escape.pdf',
      'a/../../escape.pdf',
      // path.join swallows a leading slash, so an absolute key would land
      // inside the root and overwrite another object without ever escaping it.
      '/etc/passwd',
      'a//b.pdf',
      'a/./b.pdf',
      'a\\b.pdf',
      '',
      'trailing/',
    ]) {
      await expect(
        storage.put({ key, body: Buffer.from('x'), contentType: 'application/pdf' }),
        key,
      ).rejects.toThrow(/Invalid storage key/);
    }
    // Nothing was written outside the root.
    await expect(readFile(join(root, '..', 'escape.pdf'))).rejects.toThrow();
  });

  it('refuses a key containing a null byte', async () => {
    await expect(
      storage.put({ key: 'a\u0000b.pdf', body: Buffer.from('x'), contentType: 'application/pdf' }),
    ).rejects.toThrow(/Invalid storage key/);
  });

  it('issues a signed URL that expires', async () => {
    const { url, expiresAt } = await storage.signedDownloadUrl('a/b.pdf', {
      expiresInSeconds: 300,
      downloadFilename: 'Payslip_Aug-2026.pdf',
    });

    expect(url).toContain('https://api.ess.widedrop.com/api/v1/files/download');
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 300_000);

    const params = new URL(url).searchParams;
    expect(
      storage.verifySignature(
        params.get('key')!,
        Number(params.get('expires')),
        params.get('nonce')!,
        params.get('signature')!,
      ),
    ).toBe(true);
  });

  it('rejects a tampered or expired signature', async () => {
    const { url } = await storage.signedDownloadUrl('a/b.pdf', {
      expiresInSeconds: 300,
      downloadFilename: 'x.pdf',
    });
    const params = new URL(url).searchParams;
    const expires = Number(params.get('expires'));
    const nonce = params.get('nonce')!;
    const signature = params.get('signature')!;

    // A different key must not verify against this signature.
    expect(storage.verifySignature('other/file.pdf', expires, nonce, signature)).toBe(false);
    // A stretched expiry must not verify.
    expect(storage.verifySignature('a/b.pdf', expires + 3600, nonce, signature)).toBe(false);
    // An altered signature must not verify.
    expect(storage.verifySignature('a/b.pdf', expires, nonce, 'f'.repeat(64))).toBe(false);
    // An expired URL must not verify even with a correct signature.
    const past = Math.floor(Date.now() / 1000) - 10;
    expect(storage.verifySignature('a/b.pdf', past, nonce, signature)).toBe(false);
  });

  it('deletes idempotently', async () => {
    await storage.put({ key: 'a/b.pdf', body: Buffer.from('x'), contentType: 'application/pdf' });
    await storage.delete('a/b.pdf');
    await storage.delete('a/b.pdf');
    expect(await storage.exists('a/b.pdf')).toBe(false);
  });
});
