/**
 * The API, served from the same site as the SPA.
 *
 * Netlify maps `/api/*` here (see infra/netlify/netlify.toml), so the whole
 * Fastify application answers under one function rather than one function per
 * route. That is deliberate: the plugin chain — request context, security
 * headers, rate limiting, CSRF, authentication, authorization — is registered
 * once in one order, and a route cannot end up with a different chain because
 * somebody added a function and forgot a plugin.
 *
 * Everything real is in `@widedrop/api`. This file exists because the platform
 * looks for handlers in a directory, and it stays this thin so there is
 * nothing here to diverge from the server.
 */
export { handler } from '@widedrop/api/netlify';
