import type { App } from '../app.js';

/**
 * Liveness, readiness and version.
 *
 * These are the only unauthenticated endpoints, and they are deliberately
 * uninformative: a monitor needs to know whether the process is serving, and an
 * attacker learns nothing about what is running behind it.
 */

/** Set at build time. Unknown in development, which is honest rather than faked. */
const BUILD_SHA = process.env.BUILD_SHA ?? 'development';
const BUILD_TIME = process.env.BUILD_TIME ?? null;

export async function healthRoutes(app: App): Promise<void> {
  /**
   * Liveness: is the process up? Answers without touching the database, so a
   * database blip does not cause the platform to restart a healthy process.
   */
  app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok' }));

  /**
   * Readiness: should this instance receive traffic? Checks the database,
   * because an instance that cannot reach it can serve nothing useful.
   */
  app.get('/health/ready', { logLevel: 'warn' }, async (_request, reply) => {
    try {
      await app.db.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch (error) {
      app.log.error({ err: error }, 'readiness check failed');
      return reply.status(503).send({ status: 'not-ready' });
    }
  });

  /**
   * The deployed build. Useful for confirming a rollout landed; it names a
   * commit, not a dependency tree.
   */
  app.get('/version', { logLevel: 'warn' }, async () => ({
    build: BUILD_SHA,
    builtAt: BUILD_TIME,
  }));
}
