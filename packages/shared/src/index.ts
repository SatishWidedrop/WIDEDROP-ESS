/**
 * @widedrop/shared — the contracts both the API and the web app are built on.
 *
 * Anything in here is authoritative for *shape*: roles, permissions, states,
 * validation schemas, formatting and design tokens. Authority over *access* is
 * the server's alone — the client uses this module to decide what to render,
 * never to decide what is allowed.
 */

export * from './design/tokens.js';
export * from './design/icons.js';

export * from './format/money.js';
export * from './format/date.js';

export * from './rbac/roles.js';

export * from './domain/state-machine.js';
export * from './domain/payroll.js';
export * from './domain/workflows.js';
export * from './domain/notifications.js';

export * from './contracts/common.js';
export * from './contracts/auth.js';
export * from './contracts/ess.js';
