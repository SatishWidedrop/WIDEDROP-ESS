import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PutObjectInput, SignedUrl, StorageDriver, StoredObject } from './types.js';
import { contentDisposition, isValidStorageKey } from './types.js';

/**
 * S3 storage driver — production.
 *
 * Payslips, letters, policy documents and expense bills are business records:
 * private, durable, and never served from the API's own origin. The bucket
 * blocks public access entirely; the only way to read an object is a presigned
 * URL, which this driver issues after the caller's authorization has already
 * been checked.
 *
 * Written against the S3 REST API rather than any one vendor's extensions, so
 * the same driver runs on S3, R2, Backblaze B2, Spaces or MinIO. Anything
 * vendor-specific is a configuration value, never a branch in this file.
 */
export class S3Storage implements StorageDriver {
  readonly name = 's3' as const;

  private readonly client: S3Client;
  private readonly bucket: string;

  /**
   * Some S3-compatible stores do not resolve bucket-as-subdomain, and a bucket
   * whose name is not a valid DNS label cannot be addressed that way on S3
   * either. Set by configuration rather than sniffed, so the request shape is
   * the same on every call.
   */
  private readonly forcePathStyle: boolean;

  constructor(options: {
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** Set for a non-AWS store; omitted for S3 itself. */
    endpoint?: string | undefined;
    forcePathStyle?: boolean | undefined;
  }) {
    this.bucket = options.bucket;
    this.forcePathStyle = options.forcePathStyle ?? options.endpoint !== undefined;
    this.client = new S3Client({
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: this.forcePathStyle,
      // Three attempts with the SDK's own jittered backoff. A transient 500 or
      // a throttle from the store is retried; a 403 is not, because a retried
      // authorization failure is just a slower authorization failure.
      maxAttempts: 3,
    });
  }

  private assertKey(key: string): string {
    // The keys this driver ever sees come from `buildStorageKey`. Checking
    // anyway costs nothing and means a key that reached here another way — a
    // database row edited by hand, a future caller that builds its own — never
    // becomes a request line.
    if (!isValidStorageKey(key)) throw new Error('Invalid storage key');
    return key;
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const key = this.assertKey(input.key);

    // Buffered rather than streamed. Uploads are bounded to FILE_LIMITS.maxBytes
    // and generated documents are smaller still, so the memory is bounded and
    // known — and buffering is what lets the checksum below be computed before
    // the bytes are sent, which is the whole point of sending one.
    const body = Buffer.isBuffer(input.body)
      ? input.body
      : Buffer.concat(await Readable.from(input.body).toArray());

    const sha256 = createHash('sha256').update(body).digest();

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: input.contentType,
        ContentLength: body.byteLength,
        // The store verifies this against the bytes it received and refuses the
        // write if they disagree, so a truncated upload fails here rather than
        // becoming a corrupt payslip somebody downloads next month.
        ChecksumSHA256: sha256.toString('base64'),
        // Encryption at rest. The bucket should enforce this by policy too;
        // sending it means an unencrypted object cannot be written even if the
        // bucket policy is ever relaxed.
        ServerSideEncryption: 'AES256',
        ...(input.downloadFilename
          ? { ContentDisposition: contentDisposition(input.downloadFilename) }
          : {}),
        ...(input.metadata ? { Metadata: sanitiseMetadata(input.metadata) } : {}),
      }),
    );

    return {
      key,
      size: body.byteLength,
      contentType: input.contentType,
      sha256: sha256.toString('hex'),
    };
  }

  async get(key: string) {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.assertKey(key) }),
    );

    if (!response.Body) throw new Error(`Object has no body: ${key}`);

    return {
      body: response.Body as Readable,
      contentType: response.ContentType ?? 'application/octet-stream',
      size: response.ContentLength ?? 0,
    };
  }

  /**
   * A presigned GET.
   *
   * The URL is the capability: anyone holding it can read the object until it
   * expires, which is why callers check authorization first and why the
   * lifetime is minutes rather than hours. The filename and content type are
   * pinned as response overrides so the browser saves it under a sensible name
   * and never renders it inline — an HTML file stored as an expense bill must
   * not execute on the storage origin.
   */
  async signedDownloadUrl(
    key: string,
    options: { expiresInSeconds: number; downloadFilename: string },
  ): Promise<SignedUrl> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.assertKey(key),
        ResponseContentDisposition: contentDisposition(options.downloadFilename),
        ResponseContentType: 'application/octet-stream',
      }),
      { expiresIn: options.expiresInSeconds },
    );

    return {
      url,
      expiresAt: new Date(Date.now() + options.expiresInSeconds * 1_000),
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.assertKey(key) }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.assertKey(key) }),
      );
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      // A 403 is not "absent". Swallowing it would turn a misconfigured bucket
      // policy into a silent "the payslip does not exist", which is the wrong
      // thing to tell somebody about their own pay.
      throw error;
    }
  }

  /** Release the underlying sockets. Used by tests and by graceful shutdown. */
  destroy(): void {
    this.client.destroy();
  }
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * S3 user metadata travels in HTTP headers, so a newline in a value would split
 * the request and a non-ASCII byte would be mangled. Keys are lowercased
 * because S3 returns them that way regardless, and a caller comparing against
 * what it wrote should not be surprised.
 */
function sanitiseMetadata(metadata: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(metadata)) {
    const key = rawKey.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!key) continue;
    out[key] = rawValue.replace(/[^\x20-\x7E]/g, '').slice(0, 256);
  }
  return out;
}
