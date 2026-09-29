import { PrismaClient } from '../generated/prisma/index.js';
import type { Env } from '../config/env.js';
import type { Logger } from './logger.js';

/**
 * The Prisma client.
 *
 * One instance per process. Query logging is routed through the application
 * logger so that a slow query carries the same request id as the request that
 * caused it — and so that query text, which can contain personal data, never
 * reaches the log outside development.
 */

export type Database = PrismaClient;

let client: PrismaClient | undefined;

export function createPrismaClient(env: Env, logger: Logger): PrismaClient {
  const prisma = new PrismaClient({
    datasourceUrl: env.DATABASE_URL,
    log:
      env.NODE_ENV === 'development'
        ? [
            { emit: 'event', level: 'query' },
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ]
        : [
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ],
  });

  if (env.NODE_ENV === 'development') {
    // Query text can contain personal data, so it is logged in development only.
    prisma.$on('query' as never, (event: { query: string; duration: number }) => {
      if (event.duration > 200) {
        logger.warn({ durationMs: event.duration, query: event.query }, 'slow query');
      }
    });
  }

  prisma.$on('warn' as never, (event: { message: string }) => {
    logger.warn({ prisma: event.message }, 'prisma warning');
  });

  prisma.$on('error' as never, (event: { message: string }) => {
    logger.error({ prisma: event.message }, 'prisma error');
  });

  return prisma;
}

export function getPrismaClient(env: Env, logger: Logger): PrismaClient {
  client ??= createPrismaClient(env, logger);
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

/**
 * A Prisma transaction client. Service functions accept this so that a write,
 * its audit event and its outbox row share one transaction: if the audit entry
 * cannot be written, the change does not happen.
 */
export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
