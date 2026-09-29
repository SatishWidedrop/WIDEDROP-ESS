import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';

/**
 * Response headers.
 *
 * The API serves JSON, not documents, so its own CSP is the most restrictive
 * one there is: nothing may load, nothing may frame it, nothing may execute.
 * The SPA's policy — which has real work to do — lives in the Netlify
 * configuration, alongside the site it protects.
 */
export const securityHeadersPlugin = fp(
  async (app: FastifyInstance, options: { isProduction: boolean }) => {
    await app.register(helmet, {
      // An API response is never a document. Denying everything means a stored
      // payload that somehow reached a browser as HTML still cannot do anything.
      contentSecurityPolicy: {
        // Helmet's defaults are written for a document server and include
        // `style-src 'unsafe-inline'` and `script-src 'self'`. Merging them in
        // would loosen a policy whose entire purpose is to permit nothing.
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'script-src': ["'none'"],
          'style-src': ["'none'"],
          'img-src': ["'none'"],
          'font-src': ["'none'"],
          'connect-src': ["'none'"],
          'object-src': ["'none'"],
          'media-src': ["'none'"],
          'frame-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'none'"],
          'form-action': ["'none'"],
          sandbox: [],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      // Two years, subdomains included, preload-eligible. Only meaningful over
      // TLS, so it is not set in development.
      strictTransportSecurity: options.isProduction
        ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
        : false,
      xContentTypeOptions: true,
      xFrameOptions: { action: 'deny' },
      xDnsPrefetchControl: { allow: false },
      // The header leaks the framework and version to anyone scanning.
      hidePoweredBy: true,
    });

    app.addHook('onSend', (request, reply, payload, done) => {
      // Authenticated responses carry personal data. No cache may keep them,
      // and no proxy may serve one to a second person.
      reply.header('cache-control', 'no-store, no-cache, must-revalidate, private');
      reply.header('pragma', 'no-cache');
      reply.header('vary', 'Origin, Cookie, Authorization');

      // Browsers must not sniff a JSON body into something executable.
      reply.header('x-content-type-options', 'nosniff');

      // Opt out of features the API has no use for.
      reply.header(
        'permissions-policy',
        'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()',
      );

      done(null, payload);
    });
  },
  { name: 'security-headers' },
);
