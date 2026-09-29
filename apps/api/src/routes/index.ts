import type { App } from '../app.js';
import { healthRoutes } from './health.js';

/**
 * Route registration.
 *
 * Everything under `/api/v1` requires authentication unless the route says
 * otherwise; health and version do not, and are deliberately outside the
 * versioned prefix so a monitor never has to know the API version.
 */
export async function registerRoutes(app: App): Promise<void> {
  await app.register(healthRoutes);
}
