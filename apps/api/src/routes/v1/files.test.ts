import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { type FilesystemStorage } from '../../lib/storage/filesystem.js';
import { resetStorage, storage } from '../../services/storage.js';
import { buildTestApp } from '../../test/app.js';

/**
 * The redemption endpoint for a development signed URL.
 *
 * Its whole job is to be exactly as hard to abuse as a presigned S3 URL, so
 * every test here is an attempt to read an object without a URL that was
 * legitimately issued for it.
 */
describe('GET /api/v1/files/download', () => {
  let app: App;
  let root: string;
  let driver: FilesystemStorage;

  const KEY = 'PAYSLIP_PDF/2026/08/emp_1/obj_1.pdf';
  const BYTES = Buffer.from('%PDF-1.7 a payslip');

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ess-files-'));
    resetStorage();
    app = await buildTestApp({ STORAGE_LOCAL_PATH: root });
    driver = storage(app.env) as FilesystemStorage;
    await driver.put({ key: KEY, body: BYTES, contentType: 'application/pdf' });
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
    resetStorage();
  });

  const issue = async (key = KEY, filename = 'Payslip August 2026.pdf') => {
    const { url } = await driver.signedDownloadUrl(key, {
      expiresInSeconds: 300,
      downloadFilename: filename,
    });
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  };

  it('serves the object to a correctly signed URL', async () => {
    const response = await app.inject({ method: 'GET', url: await issue() });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(BYTES)).toBe(true);
  });

  it('forces a download rather than a render, and never caches it', async () => {
    const response = await app.inject({ method: 'GET', url: await issue() });

    // An uploaded bill that is really an HTML file must not execute on the
    // API's origin, where the session cookie lives.
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="Payslip August 2026.pdf"; ' +
        "filename*=UTF-8''Payslip%20August%202026.pdf",
    );
    // Set app-wide by the security-headers plugin, and it applies here: a
    // payslip must not land in a shared cache.
    expect(response.headers['cache-control']).toBe('no-store, no-cache, must-revalidate, private');
    // The signature is in the query string; it must not travel onward.
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('refuses a URL whose key was swapped for another object', async () => {
    const issued = new URL(`http://x${await issue()}`);
    issued.searchParams.set('key', 'PAYSLIP_PDF/2026/08/emp_2/obj_2.pdf');

    const response = await app.inject({
      method: 'GET',
      url: issued.pathname + issued.search,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a URL whose expiry was extended', async () => {
    const issued = new URL(`http://x${await issue()}`);
    issued.searchParams.set('expires', String(Math.floor(Date.now() / 1000) + 86_400));

    const response = await app.inject({
      method: 'GET',
      url: issued.pathname + issued.search,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a URL that has expired', async () => {
    const { url } = await driver.signedDownloadUrl(KEY, {
      expiresInSeconds: 300,
      downloadFilename: 'p.pdf',
    });
    const issued = new URL(url);
    const expires = Math.floor(Date.now() / 1000) - 1;
    issued.searchParams.set('expires', String(expires));

    const response = await app.inject({
      method: 'GET',
      url: issued.pathname + issued.search,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a URL with no signature at all', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/files/download?key=${encodeURIComponent(KEY)}&expires=${
        Math.floor(Date.now() / 1000) + 300
      }&nonce=abc&filename=p.pdf`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a traversal key even when correctly signed', async () => {
    // Signed by us, so the signature is genuine — the key itself is the
    // attack, and the driver rejects it before it becomes a path.
    const response = await app.inject({
      method: 'GET',
      url: await issue('../../../etc/passwd').catch(() => '/api/v1/files/download?key=..'),
    });
    expect(response.statusCode).toBe(404);
  });

  it('answers 404, not 403, for a key that does not exist', async () => {
    // The caller learns nothing about which storage keys are real.
    const response = await app.inject({
      method: 'GET',
      url: await issue('PAYSLIP_PDF/2026/08/emp_9/nothing.pdf'),
    });
    expect(response.statusCode).toBe(404);
  });

  it('cannot inject a header through the filename', async () => {
    const response = await app.inject({
      method: 'GET',
      url: await issue(KEY, 'a"\r\nX-Injected: yes.pdf'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-injected']).toBeUndefined();
    expect(String(response.headers['content-disposition'])).not.toMatch(/[\r\n]/);
  });
});
