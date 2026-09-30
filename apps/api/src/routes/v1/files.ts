import { z } from 'zod';
import type { App } from '../../app.js';
import { FilesystemStorage } from '../../lib/storage/filesystem.js';
import { contentDisposition } from '../../lib/storage/types.js';
import { notFound } from '../../lib/errors.js';
import { storage } from '../../services/storage.js';

/**
 * The redemption endpoint for a filesystem-driver signed URL.
 *
 * In production the storage driver is S3 and a signed URL points straight at
 * the bucket, so this route does not exist at all — it is registered only when
 * the filesystem driver is configured. That is deliberate: a route that has no
 * job in production should not be reachable in production.
 *
 * It is unauthenticated, and that is the design rather than an oversight. The
 * URL *is* the capability, exactly as it is on S3: the calling route has
 * already decided that this person may read this object, and the signature is
 * the portable proof of that decision. What keeps it safe is the same set of
 * properties a presigned S3 URL has —
 *
 *  - the signature covers the key, the expiry and a nonce, under a key the
 *    browser never sees, so a URL cannot be edited to name another object;
 *  - it expires in minutes, so a URL left in a chat log or a proxy access log
 *    is already dead when somebody finds it;
 *  - it grants exactly one object, never a listing and never a write.
 *
 * The object is streamed through, never redirected to, because the filesystem
 * root is not served by anything else.
 */
const querySchema = z.object({
  key: z.string().min(1).max(512),
  expires: z.coerce.number().int().positive(),
  nonce: z.string().min(1).max(64),
  filename: z.string().min(1).max(200),
  signature: z.string().min(1).max(128),
});

export async function fileRoutes(app: App): Promise<void> {
  const driver = storage(app.env);

  // S3 signs its own URLs and they never come back here.
  if (!(driver instanceof FilesystemStorage)) return;

  app.get(
    '/api/v1/files/download',
    { config: { public: true, rateLimitName: 'default' } },
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);

      // Every rejection below is the same 404. A tampered signature, an
      // expired URL and a key that was never issued are indistinguishable to
      // the caller, so this endpoint cannot be used to learn which storage
      // keys exist.
      if (!parsed.success) throw notFound('The file');

      const { key, expires, nonce, filename, signature } = parsed.data;

      if (!driver.verifySignature(key, expires, nonce, signature)) {
        throw notFound('The file');
      }

      let object: Awaited<ReturnType<typeof driver.get>>;
      try {
        object = await driver.get(key);
      } catch {
        throw notFound('The file');
      }

      return (
        reply
          // Always a download, never a render. An uploaded expense bill that is
          // really an HTML file must not execute on the API's origin, where it
          // would sit alongside the session cookie.
          .header('content-type', 'application/octet-stream')
          .header('content-disposition', contentDisposition(filename))
          .header('content-length', object.size)
          .header('x-content-type-options', 'nosniff')
          // `cache-control: no-store, no-cache, must-revalidate, private` is set
          // app-wide by the security-headers plugin and applies here too, which
          // is what keeps a payslip out of a shared cache. Not repeated, because
          // a weaker duplicate would be silently ignored and read as though it
          // were the policy.
          //
          // The query string carries the signature; do not leak it onward.
          .header('referrer-policy', 'no-referrer')
          .send(object.body)
      );
    },
  );
}
