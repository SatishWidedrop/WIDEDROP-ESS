import { FilesystemStorage } from '../lib/storage/filesystem.js';
import { S3Storage } from '../lib/storage/s3.js';
import type { StorageDriver } from '../lib/storage/types.js';
import type { Env } from '../config/env.js';

/**
 * The configured storage driver.
 *
 * One instance per process. `filesystem` is development only — production
 * refuses to start with it, because a container filesystem is ephemeral and a
 * payslip is a business record.
 */
let instance: StorageDriver | undefined;

export function storage(env: Env): StorageDriver {
  instance ??= build(env);
  return instance;
}

function build(env: Env): StorageDriver {
  switch (env.STORAGE_DRIVER) {
    case 'filesystem':
      return new FilesystemStorage({
        root: env.STORAGE_LOCAL_PATH,
        // Signed URLs are verified by the API's own download route, so the
        // development flow exercises the same path as S3.
        signingKey: env.AUDIT_HMAC_KEY,
        apiBaseUrl: env.API_PUBLIC_URL,
      });

    case 's3': {
      // The env validator already refuses to start in production without
      // these, so a missing one here means somebody selected `s3` outside
      // production without finishing the job. Say which value is missing
      // rather than failing later inside the SDK.
      const missing = (
        ['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const
      ).filter((key) => !env[key]);
      if (missing.length > 0) {
        throw new Error(
          `STORAGE_DRIVER is "s3" but ${missing.join(', ')} ${
            missing.length === 1 ? 'is' : 'are'
          } not set`,
        );
      }

      return new S3Storage({
        region: env.S3_REGION as string,
        bucket: env.S3_BUCKET as string,
        accessKeyId: env.S3_ACCESS_KEY_ID as string,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
        endpoint: env.S3_ENDPOINT,
        // A custom endpoint means an S3-compatible store, which may not
        // resolve bucket-as-subdomain. On S3 itself, virtual-hosted addressing
        // is the supported form.
        forcePathStyle: Boolean(env.S3_ENDPOINT),
      });
    }
  }
}

export function resetStorage(): void {
  instance = undefined;
}
