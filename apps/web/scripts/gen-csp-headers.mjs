#!/usr/bin/env node
/**
 * Generate `dist/_headers` — the Content-Security-Policy and its reporting
 * endpoint.
 *
 * These two headers are generated rather than committed because their value
 * contains the API origin, which differs per deploy context. Everything
 * context-invariant lives in `infra/netlify/netlify.toml`; no header name
 * appears in both, because Netlify merges the two sources and would otherwise
 * emit the same header twice.
 *
 * The script also asserts the things the policy depends on. Each failure exits
 * non-zero and fails the deploy, because a CSP that has to be widened after
 * the fact is a CSP nobody trusts.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DIST = path.resolve(process.cwd(), 'dist');
const apiBaseUrl = process.env.VITE_API_BASE_URL ?? '';
const context = process.env.CONTEXT ?? process.env.VITE_APP_ENV ?? 'development';
const reportOnly = process.env.CSP_REPORT_ONLY === 'true';

const failures = [];
const fail = (message) => failures.push(message);

/* ------------------------------------------------------------------ */
/* 1. The API origin is an origin                                      */
/* ------------------------------------------------------------------ */

/*
 * `self` means the API answers on this origin, under /api — a Netlify
 * function on the same site rather than a separate host. The SPA then issues
 * relative requests and connect-src needs no host at all, which removes the
 * possibility of the policy and the client disagreeing about one.
 *
 * Anything else must be a bare https origin.
 */
const sameOrigin = apiBaseUrl === 'self';

let origin;
if (!sameOrigin) {
  try {
    const url = new URL(apiBaseUrl);
    if (url.protocol !== 'https:' && !isLocal(url)) {
      fail(`VITE_API_BASE_URL must be https outside local development: ${apiBaseUrl}`);
    }
    if (url.pathname !== '/' || url.search || url.hash) {
      fail(`VITE_API_BASE_URL must be a bare origin with no path: ${apiBaseUrl}`);
    }
    origin = url.origin;
  } catch {
    fail(
      `VITE_API_BASE_URL must be "self" or a bare https origin, not: ${apiBaseUrl || '(unset)'}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 2. Production points at production, and is not report-only          */
/* ------------------------------------------------------------------ */

if (context === 'production') {
  // Same-origin needs no check: there is no other host it could be talking to.
  if (!sameOrigin && origin !== 'https://api-ess.widedrop.com') {
    fail(`the production build must talk to https://api-ess.widedrop.com, not ${origin}`);
  }
  if (reportOnly) {
    // Report-only is for exactly one release while a policy change is
    // observed. Leaving it on means the policy is documentation, not a
    // control, and nothing would tell you.
    fail('CSP_REPORT_ONLY must not be set for a production build');
  }
}

/* ------------------------------------------------------------------ */
/* 3. No secret reached the bundle                                     */
/* ------------------------------------------------------------------ */

const SECRETISH = /KEY|SECRET|TOKEN|PASSWORD|PEPPER|CREDENTIAL/i;

for (const name of Object.keys(process.env)) {
  if (name.startsWith('VITE_') && SECRETISH.test(name)) {
    // Every VITE_ variable is compiled into the bundle and served to anyone
    // who loads the page. A name that sounds like a secret is treated as one.
    fail(`${name} would be baked into the bundle; a VITE_ variable is public`);
  }
}

/* ------------------------------------------------------------------ */
/* 4. Nothing needs 'unsafe-inline'                                    */
/* ------------------------------------------------------------------ */

const files = walk(DIST);

for (const file of files.filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(file, 'utf8');
  if (/\sstyle="/.test(html)) {
    fail(`${rel(file)} contains an inline style attribute, which style-src-attr 'none' blocks`);
  }
  if (/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html)) {
    fail(`${rel(file)} contains an inline script, which script-src 'self' blocks`);
  }
}

for (const file of files.filter((f) => f.endsWith('.js'))) {
  const source = readFileSync(file, 'utf8');
  // React sets individual CSSOM properties, which no directive governs. What
  // this catches is string-built markup, which does need 'unsafe-inline'.
  if (source.includes(".setAttribute('style'") || source.includes('.setAttribute("style"')) {
    fail(`${rel(file)} sets a style attribute, which style-src-attr 'none' blocks`);
  }
}

/* ------------------------------------------------------------------ */
/* 5. Nothing is loaded from another host                              */
/* ------------------------------------------------------------------ */

for (const file of files.filter((f) => f.endsWith('.css'))) {
  const css = readFileSync(file, 'utf8');
  const external = [...css.matchAll(/url\(\s*['"]?(https?:)?\/\/([^'")]+)/g)];
  for (const match of external) {
    fail(`${rel(file)} loads ${match[0]} from another host; font-src and img-src are 'self'`);
  }
  if (/@import\s+url\(\s*['"]?https?:/.test(css)) {
    fail(`${rel(file)} imports a stylesheet from another host`);
  }
}

/* ------------------------------------------------------------------ */
/* 6. The bundle talks to the origin the policy permits                */
/* ------------------------------------------------------------------ */

/*
 * `connect-src` is generated from VITE_API_BASE_URL, so if the bundle reads
 * some *other* variable for its base URL the policy permits an origin the app
 * never calls — and the app calls an origin the policy forbids. That is
 * exactly what shipped once: the client read `VITE_API_URL`, nothing set it,
 * and the fallback made every request relative, so the SPA called its own
 * Netlify host and got a 404 from the catch-all.
 *
 * Nothing about that is visible in a build log, a typecheck or a test that
 * runs against a local API. The one place it is visible is the bundle: if the
 * origin was compiled in, `VITE_API_BASE_URL` reached the code that matters.
 *
 * Skipped when the origin is empty by design — in development Vite proxies
 * /api and a relative base URL is the correct answer.
 */
if (!sameOrigin && origin && !isLocal(new URL(origin))) {
  const bundles = files.filter((f) => f.endsWith('.js'));
  const mentions = bundles.some((file) => readFileSync(file, 'utf8').includes(origin));
  if (!mentions) {
    fail(
      `no bundle contains ${origin}: the client is not reading VITE_API_BASE_URL, ` +
        'so it will call its own origin while the policy permits the API',
    );
  }
}

/* ------------------------------------------------------------------ */
/* 7. A stray _headers or _redirects would be merged in                */
/* ------------------------------------------------------------------ */

for (const name of ['_headers', '_redirects']) {
  const inPublic = path.resolve(process.cwd(), 'public', name);
  if (exists(inPublic)) {
    fail(`apps/web/public/${name} would be copied into dist and merged with the generated one`);
  }
}

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  console.error('\nCSP header generation refused:\n');
  for (const failure of failures) console.error(`  · ${failure}`);
  console.error('');
  process.exit(1);
}

const headerName = reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';

/**
 * The policy.
 *
 * `default-src 'none'` and then only what the app actually needs. There is no
 * `'unsafe-inline'` anywhere: the styles are in CSS Modules and the scripts
 * are files, which is what makes that possible.
 *
 *  - `img-src` allows `blob:` for a downloaded document the browser renders
 *    from memory, and `data:` for nothing — an SVG data URI is a script
 *    delivery mechanism.
 *  - `form-action 'none'` because every submission goes through fetch. A form
 *    that posts anywhere is a phishing page injected into ours.
 *  - `frame-ancestors 'none'` is the one that actually stops clickjacking;
 *    X-Frame-Options in netlify.toml is for browsers that predate it.
 */
const policy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'none'",
  "style-src-elem 'self'",
  "img-src 'self' blob:",
  "font-src 'self'",
  // 'self' alone when the API shares this origin; the host is named only
  // when it does not.
  sameOrigin ? "connect-src 'self'" : `connect-src 'self' ${origin}`,
  "manifest-src 'self'",
  "worker-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "media-src 'none'",
  'upgrade-insecure-requests',
  `report-uri ${origin}/api/v1/csp-report`,
  'report-to csp',
].join('; ');

const body = `# GENERATED by apps/web/scripts/gen-csp-headers.mjs — do not edit, do not commit.
# Context: ${context}${reportOnly ? ' (report-only)' : ''}
/*
  ${headerName}: ${policy}
  Reporting-Endpoints: csp="${origin}/api/v1/csp-report"
`;

writeFileSync(path.join(DIST, '_headers'), body, 'utf8');

console.log(`wrote dist/_headers (${headerName}, connect-src ${sameOrigin ? "'self'" : origin})`);

/* ------------------------------------------------------------------ */

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

function exists(file) {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}

function rel(file) {
  return path.relative(process.cwd(), file);
}

function isLocal(url) {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}
