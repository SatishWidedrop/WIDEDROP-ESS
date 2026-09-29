import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { PutObjectInput, SignedUrl, StorageDriver, StoredObject } from './types.js';

/**
 * Filesystem storage driver — development only.
 *
 * Production refuses to start with this driver (see config/env.ts): a container
 * filesystem is ephemeral, and business records must outlive a deploy.
 *
 * Signed URLs are HMACs over the key and expiry, verified by the API's own
 * download route, so the development flow exercises the same code path as S3.
 */
export class FilesystemStorage implements StorageDriver {
  readonly name = 'filesystem' as const;

  private readonly root: string;
  private readonly signingKey: Buffer;
  private readonly baseUrl: string;

  constructor(options: { root: string; signingKey: string; apiBaseUrl: string }) {
    this.root = resolve(options.root);
    this.signingKey = Buffer.from(options.signingKey, 'base64');
    this.baseUrl = options.apiBaseUrl.replace(/\/+$/, '');
  }

  /**
   * Resolve a key to an absolute path.
   *
   * Keys are generated server-side by `buildStorageKey`, so this is defence in
   * depth: the shape is validated first (relative, no traversal, no separators
   * other than `/`, no control characters) and the resolved path is then
   * confirmed to sit inside the root. The shape check matters on its own —
   * `path.join` silently swallows a leading slash, so an absolute key would land
   * inside the root rather than being rejected, and a caller could overwrite a
   * different object without ever leaving the directory.
   */
  private pathFor(key: string): string {
    if (!FilesystemStorage.isValidKey(key)) {
      throw new Error('Invalid storage key');
    }
    const target = resolve(join(this.root, normalize(key)));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error('Invalid storage key');
    }
    return target;
  }

  /** The exact shape `buildStorageKey` produces, and nothing else. */
  static isValidKey(key: string): boolean {
    if (key.length === 0 || key.length > 512) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F\\]/.test(key)) return false;
    if (key.startsWith('/') || key.endsWith('/')) return false;
    const segments = key.split('/');
    return segments.every((segment) => segment.length > 0 && /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..');
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const path = this.pathFor(input.key);
    await mkdir(dirname(path), { recursive: true });

    const body = Buffer.isBuffer(input.body)
      ? input.body
      : Buffer.concat(await Readable.from(input.body).toArray());

    await writeFile(path, body, { mode: 0o600 });

    return {
      key: input.key,
      size: body.byteLength,
      contentType: input.contentType,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
  }

  async get(key: string) {
    const path = this.pathFor(key);
    const info = await stat(path);
    return {
      body: createReadStream(path),
      contentType: 'application/octet-stream',
      size: info.size,
    };
  }

  async signedDownloadUrl(
    key: string,
    options: { expiresInSeconds: number; downloadFilename: string },
  ): Promise<SignedUrl> {
    const expires = Math.floor(Date.now() / 1000) + options.expiresInSeconds;
    const nonce = randomBytes(8).toString('hex');
    const signature = this.sign(key, expires, nonce);
    const params = new URLSearchParams({
      key,
      expires: String(expires),
      nonce,
      filename: options.downloadFilename,
      signature,
    });
    return {
      url: `${this.baseUrl}/api/v1/files/download?${params.toString()}`,
      expiresAt: new Date(expires * 1000),
    };
  }

  /** Verify a signature produced by `signedDownloadUrl`. */
  verifySignature(key: string, expires: number, nonce: string, signature: string): boolean {
    if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;
    const expected = this.sign(key, expires, nonce);
    if (expected.length !== signature.length) return false;
    // Both sides are hex of the same length, so a plain comparison over buffers
    // is safe to do in constant time.
    return createHmac('sha256', this.signingKey).update(expected).digest('hex') ===
      createHmac('sha256', this.signingKey).update(signature).digest('hex');
  }

  private sign(key: string, expires: number, nonce: string): string {
    return createHmac('sha256', this.signingKey)
      .update(key)
      .update('\u0000')
      .update(String(expires))
      .update('\u0000')
      .update(nonce)
      .digest('hex');
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }
}
