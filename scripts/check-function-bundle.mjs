#!/usr/bin/env node
/**
 * Check what the API function will contain before a deploy finds out.
 *
 * Two things here fail in ways that are slow and expensive to diagnose, and
 * both are checkable in a second:
 *
 *  1. **The size.** AWS caps a Lambda at 50 MB zipped and Netlify cannot raise
 *     it. Before the exclusions in netlify.toml this function was 53 MB —
 *     over, and the deploy simply fails at the end of a build. The margin is
 *     worth watching rather than rediscovering.
 *
 *  2. **The AWS SDK's dependency tree.** Netlify's bundler treats `@aws-sdk/*`
 *     as provided by the Lambda runtime and omits it, so the SDK is shipped
 *     deliberately by path. Those paths are globs over scopes, and an SDK
 *     upgrade that introduces a new scope — which is how `@aws/lambda-invoke-
 *     store` arrived — would pass the build and then fail at the first
 *     payslip download with MODULE_NOT_FOUND.
 *
 * This checks (2) always, because it needs nothing but the installed tree, and
 * (1) when the bundler is available.
 *
 *   node scripts/check-function-bundle.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repoRoot = new URL('../', import.meta.url);
const read = (path) => readFileSync(fileURLToPath(new URL(path, repoRoot)), 'utf8');

/** Zipped, in bytes. AWS's limit, which Netlify cannot raise. */
const LIMIT_BYTES = 50 * 1024 * 1024;
/** Below this, a few more dependencies are not a crisis. */
const COMFORTABLE_BYTES = 35 * 1024 * 1024;

const failures = [];

/* ------------------------------------------------------------------ */
/* 1. Every package the SDK needs is covered by a glob                 */
/* ------------------------------------------------------------------ */

const config = read('infra/netlify/netlify.toml');

/** The positive `included_files` entries, which is what actually ships. */
const globs = [...config.matchAll(/^\s*"(node_modules\/[^"]+)",?$/gm)]
  .map((match) => match[1])
  .filter((entry) => !entry.startsWith('!'));

if (globs.length === 0) {
  failures.push('no node_modules globs found in netlify.toml — has included_files been changed?');
}

/** A glob such as `node_modules/@aws*` matches `@aws-sdk/client-s3`. */
const covers = (glob, packageName) => {
  const prefix = glob.replace(/^node_modules\//, '').replace(/\/\*\*$/, '');
  const pattern = new RegExp(
    `^${prefix.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}(/|$)`,
  );
  return pattern.test(packageName);
};

const require_ = createRequire(fileURLToPath(new URL('apps/api/package.json', repoRoot)));

/** Every package reachable from the ones the storage driver imports. */
function dependencyTree(roots) {
  const seen = new Set();
  const unresolvable = new Set();

  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    let manifest;
    try {
      manifest = require_(`${name}/package.json`);
    } catch {
      // A package whose manifest is not exported still ships; it is its
      // dependencies that cannot be walked, and the scope glob covers them.
      unresolvable.add(name);
      return;
    }
    for (const dependency of Object.keys(manifest.dependencies ?? {})) walk(dependency);
  };

  for (const root of roots) walk(root);
  return { packages: seen, unresolvable };
}

const { packages } = dependencyTree(['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner']);

const uncovered = [...packages].filter((name) => !globs.some((glob) => covers(glob, name)));

if (uncovered.length > 0) {
  failures.push(
    `the AWS SDK's dependency tree is not fully shipped — ${uncovered.length} package(s) ` +
      `match no glob in netlify.toml:\n` +
      uncovered.map((name) => `      ${name}`).join('\n') +
      `\n\n    The bundler omits @aws-sdk/* on the assumption the Lambda runtime ` +
      `provides it,\n    so anything missing here fails at runtime rather than at build time. ` +
      `Add a glob\n    covering the scope to [functions."api"].included_files.`,
  );
} else {
  console.log(`the AWS SDK's ${packages.size} packages are all covered by ${globs.length} globs`);
}

/* ------------------------------------------------------------------ */
/* 2. The bundle fits, when the bundler is available                   */
/* ------------------------------------------------------------------ */

const sizeArgument = process.argv.find((arg) => arg.startsWith('--size='));
if (sizeArgument) {
  const bytes = Number(sizeArgument.slice('--size='.length));
  const mb = (bytes / (1024 * 1024)).toFixed(1);

  if (!Number.isFinite(bytes) || bytes <= 0) {
    failures.push(`--size was not a byte count: ${sizeArgument}`);
  } else if (bytes > LIMIT_BYTES) {
    failures.push(
      `the function is ${mb} MB zipped, over AWS's 50 MB limit. ` +
        'Netlify cannot raise it; something has to come out.',
    );
  } else if (bytes > COMFORTABLE_BYTES) {
    console.warn(
      `warning: the function is ${mb} MB zipped, within 15 MB of the 50 MB limit. ` +
        'Worth trimming before it is urgent.',
    );
  } else {
    console.log(`the function is ${mb} MB zipped, comfortably under the 50 MB limit`);
  }
}

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  console.error('\nThe API function would not work as configured:\n');
  for (const failure of failures) console.error(`  · ${failure}\n`);
  process.exit(1);
}
