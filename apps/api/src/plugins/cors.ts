import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import cors from '@fastify/cors';

/**
 * Cross-origin access.
 *
 * An exact allowlist, never a wildcard and never a reflected origin: the API
 * answers with credentials, so reflecting whatever origin asked would let any
 * site on the internet read an employee's payroll data using their own session.
 */
export const corsPlugin = fp(
  async (app: FastifyInstance, options: { allowedOrigins: string[] }) => {
    const allowed = new Set(options.allowedOrigins);

    await app.register(cors, {
      origin(origin, callback) {
        // Same-origin and non-browser callers (curl, server-to-server, health
        // checks) send no Origin header at all.
        if (!origin) return callback(null, true);
        if (allowed.has(origin)) return callback(null, true);

        app.log.warn({ origin }, 'cors origin rejected');
        // Refuse by not setting the header, rather than by erroring: the
        // browser blocks the read, and a scanner learns nothing.
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'content-type',
        'authorization',
        'x-csrf-token',
        'idempotency-key',
        'if-match',
      ],
      exposedHeaders: ['x-request-id', 'retry-after'],
      maxAge: 600,
      strictPreflight: true,
    });
  },
  { name: 'cors' },
);
