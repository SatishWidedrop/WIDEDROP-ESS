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
export interface RequestContextOptions {
  /** Whether a proxy sits in front at all. */
  trustProxy: boolean;
  /**
   * How many proxies between this process and the client append to
   * `X-Forwarded-For`. See `clientIp`.
   */
  trustedProxyHops: number;
  /**
   * A single-value header the platform sets itself, where one exists —
   * `x-nf-client-connection-ip` on Netlify, `cf-connecting-ip` behind
   * Cloudflare. Preferred over `X-Forwarded-For` because the platform
   * overwrites it rather than appending to it, so a client cannot contribute
   * to it.
   */
  clientIpHeader?: string | undefined;
}

export const requestContextPlugin = fp(
  async (app: FastifyInstance, options: RequestContextOptions) => {
    app.addHook('onRequest', (request, reply, done) => {
      // Minted by Fastify's genReqId, never taken from the client: an attacker
      // who chose their own could collide or poison log correlation.
      const requestId = request.id;
      const upstreamId = request.headers['x-request-id'];

      const context: RequestContext = {
        requestId,
        personas: [],
        ip: clientIp(request, options),
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
      runWithContext(context, done);
    });
  },
  { name: 'request-context' },
);

/**
 * The client's address.
 *
 * This decides which bucket a per-IP rate limit counts against and which
 * address the audit trail records, so a client that can choose it can slip
 * past both. Getting it right is more subtle than it looks.
 *
 * ── Why not the first entry of X-Forwarded-For ───────────────────────
 * Because the header is a trail, not a field, and each proxy *appends* the
 * address it received the connection from. A client that sends
 * `X-Forwarded-For: 9.9.9.9` and is then proxied once arrives as
 * `9.9.9.9, <their real address>` — so the leftmost entry is whatever the
 * client typed, and reading it is reading attacker-supplied input. That is
 * true of Netlify, Cloudflare and Render alike; it is not a quirk of one.
 *
 * ── What is read instead ─────────────────────────────────────────────
 * A single-value header the platform sets itself, where the platform offers
 * one. Those are overwritten rather than appended, so nothing the client sends
 * survives into them.
 *
 * Failing that, the trail is counted from the right. With `n` trusted proxies
 * in front, the entries they contributed are the last `n`, and the address the
 * nearest-to-the-client one saw sits at `length - n`. Everything left of it
 * came from outside and is ignored.
 */
function clientIp(request: FastifyRequest, options: RequestContextOptions): string | undefined {
  if (!options.trustProxy) return request.socket.remoteAddress ?? undefined;

  if (options.clientIpHeader) {
    const value = request.headers[options.clientIpHeader];
    const single = typeof value === 'string' ? value.trim() : undefined;
    if (single) return single;
  }

  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const trail = forwarded
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    // Clamped, because a client can make the trail shorter than the configured
    // hop count by sending no header at all — and the leftmost entry is then
    // the safest of the bad options rather than an arbitrary one.
    const index = Math.max(0, trail.length - options.trustedProxyHops);
    const candidate = trail[index];
    if (candidate) return candidate;
  }

  return request.ip;
}
