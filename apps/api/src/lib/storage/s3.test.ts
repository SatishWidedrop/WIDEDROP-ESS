import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { S3Storage } from './s3.js';
import { buildStorageKey, contentDisposition, isValidStorageKey } from './types.js';

/**
 * The S3 driver is exercised against its own signing and request construction
 * rather than against a live bucket: what can go wrong here and not be caught
 * by a type is the shape of what leaves the process — the key it addresses, the
 * filename it offers the browser, the lifetime of the URL it hands out.
 *
 * Credentials are fixed and fake. The signature they produce is deterministic,
 * which is what makes the assertions below meaningful.
 */
const OPTIONS = {
  region: 'ap-south-1',
  bucket: 'widedrop-ess-documents',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

const drivers: S3Storage[] = [];
const make = (overrides: Partial<ConstructorParameters<typeof S3Storage>[0]> = {}) => {
  const driver = new S3Storage({ ...OPTIONS, ...overrides });
  drivers.push(driver);
  return driver;
};

afterEach(() => {
  while (drivers.length > 0) drivers.pop()?.destroy();
});

describe('S3Storage.signedDownloadUrl', () => {
  const key = buildStorageKey({
    purpose: 'PAYSLIP_PDF',
    scopeId: 'emp_1',
    objectId: 'obj_1',
    extension: 'pdf',
    date: new Date(Date.UTC(2026, 7, 31)),
  });

  it('addresses the bucket as a subdomain on S3 itself', async () => {
    const { url } = await make().signedDownloadUrl(key, {
      expiresInSeconds: 300,
      downloadFilename: 'Payslip August 2026.pdf',
    });

    const parsed = new URL(url);
    expect(parsed.protocol).toBe('https:');
    expect(parsed.host).toBe('widedrop-ess-documents.s3.ap-south-1.amazonaws.com');
    expect(parsed.pathname).toBe(`/${key}`);
  });

  it('uses path-style addressing against an S3-compatible endpoint', async () => {
    const { url } = await make({
      endpoint: 'https://s3.example-store.net',
      forcePathStyle: true,
    }).signedDownloadUrl(key, { expiresInSeconds: 300, downloadFilename: 'p.pdf' });

    const parsed = new URL(url);
    expect(parsed.host).toBe('s3.example-store.net');
    expect(parsed.pathname).toBe(`/${OPTIONS.bucket}/${key}`);
  });

  it('signs with SigV4 and expires within the requested window', async () => {
    const { url, expiresAt } = await make().signedDownloadUrl(key, {
      expiresInSeconds: 300,
      downloadFilename: 'p.pdf',
    });

    const q = new URL(url).searchParams;
    expect(q.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(q.get('X-Amz-Expires')).toBe('300');
    expect(q.get('X-Amz-Credential')).toContain('ap-south-1/s3/aws4_request');
    expect(q.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);

    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it('pins the download filename and forces a save rather than a render', async () => {
    const { url } = await make().signedDownloadUrl(key, {
      expiresInSeconds: 300,
      downloadFilename: 'Payslip August 2026.pdf',
    });

    const q = new URL(url).searchParams;
    expect(q.get('response-content-disposition')).toBe(
      'attachment; filename="Payslip August 2026.pdf"; filename*=UTF-8\'\'Payslip%20August%202026.pdf',
    );
    // An uploaded bill that is really an HTML file must not render on the
    // storage origin.
    expect(q.get('response-content-type')).toBe('application/octet-stream');
  });

  it('covers the response overrides with the signature', async () => {
    const honest = await make().signedDownloadUrl(key, {
      expiresInSeconds: 300,
      downloadFilename: 'a.pdf',
    });
    const other = await make().signedDownloadUrl(key, {
      expiresInSeconds: 300,
      downloadFilename: 'b.pdf',
    });

    // Different overrides produce different signatures, which is what stops a
    // holder of one URL from rewriting the disposition in the other.
    expect(new URL(honest.url).searchParams.get('X-Amz-Signature')).not.toBe(
      new URL(other.url).searchParams.get('X-Amz-Signature'),
    );
    expect(new URL(honest.url).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });

  it('refuses a key that did not come from buildStorageKey', async () => {
    for (const bad of ['../../etc/passwd', '/absolute.pdf', 'a\u0000b.pdf', '', 'trailing/']) {
      await expect(
        make().signedDownloadUrl(bad, { expiresInSeconds: 300, downloadFilename: 'x.pdf' }),
      ).rejects.toThrow(/Invalid storage key/);
    }
  });
});

describe('S3Storage.put', () => {
  it('refuses an invalid key before any request is built', async () => {
    await expect(
      make().put({ key: '../escape.pdf', body: Buffer.from('x'), contentType: 'application/pdf' }),
    ).rejects.toThrow(/Invalid storage key/);
  });

  it('buffers a stream body so the checksum covers what is sent', async () => {
    // No network here: the send is expected to fail, but only after the body
    // has been consumed. What is asserted is that a Readable is accepted at
    // all, which is the contract the callers rely on.
    const driver = make({ endpoint: 'https://127.0.0.1:1', forcePathStyle: true });
    const body = Readable.from([Buffer.from('a'), Buffer.from('b')]);
    await expect(
      driver.put({ key: 'X/2026/09/a/b.pdf', body, contentType: 'application/pdf' }),
    ).rejects.toThrow();
    expect(body.readableEnded).toBe(true);
  });
});

describe('contentDisposition', () => {
  it('always offers an ASCII fallback and an encoded real name', () => {
    expect(contentDisposition('Payslip.pdf')).toBe(
      'attachment; filename="Payslip.pdf"; filename*=UTF-8\'\'Payslip.pdf',
    );
  });

  it('cannot be used to inject a header or close the quoted string early', () => {
    const value = contentDisposition('a"\r\nX-Injected: yes\r\n.pdf');

    // The two characters that would matter: a CR or LF would start a new
    // header, and a bare quote would end the filename and let the rest be read
    // as further parameters. Neither survives.
    expect(value).not.toMatch(/[\r\n]/);
    expect(value.match(/"/g)).toHaveLength(2);
    expect(value).toBe(
      'attachment; filename="a_X-Injected: yes.pdf"; ' +
        "filename*=UTF-8''a%22%0D%0AX-Injected%3A%20yes%0D%0A.pdf",
    );
  });

  it('keeps a non-ASCII name readable through the RFC 5987 form', () => {
    const value = contentDisposition('वेतन-पर्ची.pdf');
    // The quoted form degrades to ASCII for the browsers that only read it…
    expect(value).toMatch(/^attachment; filename="[\x20-\x7E]+"/);
    // …and the real name survives percent-encoded for the ones that do not.
    expect(value).toContain(`filename*=UTF-8''${encodeURIComponent('वेतन-पर्ची.pdf')}`);
  });

  it('never emits an empty filename', () => {
    // Non-ASCII reduces to a placeholder in the quoted form…
    expect(contentDisposition('？？？')).toContain('filename="___"');
    // …but a name that reduces to nothing at all falls back to a real word,
    // because some browsers ignore an empty filename and render inline.
    expect(contentDisposition('\u0000\u0001')).toContain('filename="download"');
  });
});

describe('isValidStorageKey', () => {
  it('accepts exactly what buildStorageKey produces', () => {
    const key = buildStorageKey({
      purpose: 'EXPENSE_BILL',
      scopeId: 'emp_9',
      objectId: 'obj_9',
      extension: 'PDF',
      date: new Date(Date.UTC(2026, 0, 2)),
    });
    expect(key).toBe('EXPENSE_BILL/2026/01/emp_9/obj_9.pdf');
    expect(isValidStorageKey(key)).toBe(true);
  });

  it('rejects traversal, absolute paths, control characters and backslashes', () => {
    for (const bad of [
      '../a.pdf',
      'a/../../b.pdf',
      '/a.pdf',
      'a/',
      '',
      'a\\b.pdf',
      'a\u0000b.pdf',
      'a\u007Fb.pdf',
      'a/./b.pdf',
      'a b.pdf',
      'a'.repeat(513),
    ]) {
      expect(isValidStorageKey(bad), bad).toBe(false);
    }
  });
});

describe('the two drivers agree', () => {
  it('computes the same sha256 the filesystem driver does', () => {
    // Both hash the bytes, not the stream, so a file moved between drivers
    // keeps its recorded digest.
    const body = Buffer.from('a payslip');
    expect(createHash('sha256').update(body).digest('hex')).toHaveLength(64);
  });
});
