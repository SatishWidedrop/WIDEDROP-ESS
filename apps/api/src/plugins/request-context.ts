import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { runWithContext, type RequestContext } from '../lib/request-context.js';

declare module 'fastify' {
  interface FastifyRequest {
    context: RequestContext;
  }
}

/**
 * Establishes the per-request context before anything else runs.
 *
 * Every log line, audit row and outbound error carries the same request id, so
 * a user reporting "something went wrong" can be traced to the exact request
 * without searching by timestamp.
 *
 * The id is generated here rather than taken from the client: an attacker who
 * chose their own would be able to poison or collide log correlation. An
 * inbound `x-request-id` is recorded separately for upstream correlation only.
 */
export const requestContextPlugin = fp(
  async (app: FastifyInstance, options: { trustProxy: boolean }) => {
    app.addHook('onRequest', (request, reply, done) => {
      const requestId = randomUUID();
      const upstreamId = request.headers['x-request-id'];

      const context: RequestContext = {
        requestId,
        personas: [],
        ip: clientIp(request, options.trustProxy),
        userAgent:
          typeof request.headers['user-agent'] === 'string'
            ? request.headers['user-agent'].slice(0, 300)
            : undefined,
        route: request.routeOptions?.url ?? request.url.split('?')[0],
      };

      request.context = context;
      reply.header('x-request-id', requestId);

      if (typeof upstreamId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(upstreamId)) {
        request.log = request.log.child({ upstreamRequestId: upstreamId });
      }
      request.log = request.log.child({ requestId });

      runWithContext(context, done);
    });
  },
  { name: 'request-context' },
);

/**
 * The client's address.
 *
 * `X-Forwarded-For` is honoured only when the deployment says a trusted proxy
 * sits in front; otherwise any client could spoof their address and slip past
 * per-IP rate limits and lockouts.
 */
function clientIp(request: FastifyRequest, trustProxy: boolean): string | undefined {
  if (!trustProxy) return request.socket.remoteAddress ?? undefined;
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.ip;
}
