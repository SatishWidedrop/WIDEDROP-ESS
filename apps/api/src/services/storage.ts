import { FilesystemStorage } from '../lib/storage/filesystem.js';
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

    case 's3':
      // The S3 driver is selected by configuration and implemented alongside
      // the deployment work; the env validator already refuses to start in
      // production without its credentials.
      throw new Error(
        'The S3 storage driver is not built into this image. Set STORAGE_DRIVER=filesystem for development.',
      );
  }
}

export function resetStorage(): void {
  instance = undefined;
}
