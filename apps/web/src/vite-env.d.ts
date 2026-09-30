/// <reference types="vite/client" />

/**
 * The build-time configuration the SPA reads.
 *
 * Declared so a typo is a compile error rather than `undefined` at runtime.
 * Every `VITE_` variable is compiled into the bundle and served to anyone who
 * loads the page, so nothing secret may ever appear here — the build asserts
 * that too, in scripts/gen-csp-headers.mjs.
 */
interface ImportMetaEnv {
  /**
   * Origin of the API, with no trailing path — `https://api-ess.widedrop.com`.
   *
   * Empty in development, where Vite proxies `/api` to the local API so
   * cookies behave as they do in production. The CSP's `connect-src` is
   * generated from this same value, so the two cannot disagree.
   */
  readonly VITE_API_BASE_URL?: string;
  /** `development`, `staging` or `production`. Display and diagnostics only. */
  readonly VITE_APP_ENV?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
