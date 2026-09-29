import { AsyncLocalStorage } from 'node:async_hooks';
import type { Persona } from '@widedrop/shared';

/**
 * Per-request context.
 *
 * Carried implicitly so that audit writes and log lines deep in a service do not
 * have to thread the actor and request id through every call signature — and so
 * that they cannot be omitted by accident.
 */

export interface RequestContext {
  requestId: string;
  organizationId?: string;
  userId?: string;
  employeeId?: string;
  personas: Persona[];
  ip?: string;
  userAgent?: string;
  /** The route pattern, for rate-limit keys and metrics. */
  route?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The context, or a throw. Used by code that must not run outside a request —
 * an audit write with no actor is a bug, not a row with a null actor.
 */
export function requireContext(): RequestContext {
  const context = storage.getStore();
  if (!context) {
    throw new Error('No request context: this code must run inside a request or a job scope');
  }
  return context;
}

/** Run a background job under a synthetic context so its writes are attributable. */
export function runAsSystem<T>(
  input: { requestId: string; organizationId?: string; job: string },
  fn: () => T,
): T {
  return storage.run(
    {
      requestId: input.requestId,
      organizationId: input.organizationId,
      personas: [],
      route: `job:${input.job}`,
    },
    fn,
  );
}
