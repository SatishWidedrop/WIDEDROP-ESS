import type { App } from '../app.js';
import { generateDevelopmentKeyPair, loadTokenKeys } from '../services/auth/tokens.js';
import { authenticatePlugin } from '../plugins/authenticate.js';
import { healthRoutes } from './health.js';
import { authRoutes } from './v1/auth.routes.js';
import { meRoutes } from './v1/me.js';

/**
 * Route registration.
 *
 * Health and version sit outside the versioned prefix, so a monitor never has
 * to know the API version. Everything under `/api/v1` requires a session unless
 * its config says otherwise.
 */
export async function registerRoutes(app: App): Promise<void> {
  const env = app.env;

  // Outside production, a missing key pair is generated so a developer can run
  // the API without ceremony. Production refuses to start without real keys.
  let privateKeyBase64 = env.JWT_PRIVATE_KEY;
  let publicKeyBase64 = env.JWT_PUBLIC_KEY;

  if (env.NODE_ENV !== 'production') {
    const looksLikePem = (value: string) =>
      Buffer.from(value, 'base64').toString('utf8').includes('KEY');
    if (!looksLikePem(privateKeyBase64) || !looksLikePem(publicKeyBase64)) {
      const generated = generateDevelopmentKeyPair();
      privateKeyBase64 = generated.privateKeyBase64;
      publicKeyBase64 = generated.publicKeyBase64;
      app.log.warn(
        'generated an ephemeral JWT key pair: sessions will not survive a restart. Set JWT_PRIVATE_KEY and JWT_PUBLIC_KEY for a stable one.',
      );
    }
  }

  const keys = await loadTokenKeys({
    privateKeyBase64,
    publicKeyBase64,
    keyId: env.JWT_KEY_ID,
  });

  await app.register(authenticatePlugin, { keys, db: app.db });
  await app.register(healthRoutes);
  await app.register(authRoutes, { keys });
  await app.register(meRoutes);
}
