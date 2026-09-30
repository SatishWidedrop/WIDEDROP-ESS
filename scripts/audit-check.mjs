#!/usr/bin/env node
/**
 * The dependency-audit gate.
 *
 * `npm audit --audit-level=high` on its own is all-or-nothing: the moment an
 * advisory lands with no fixed release, the only ways to get a green pipeline
 * are to lower the threshold for everything or to turn the check off. Both
 * throw away the signal, and neither leaves any record of the decision.
 *
 * So this wrapper keeps the threshold where it belongs — any high or critical
 * advisory fails the build — and allows a named exception only when somebody
 * has written down which advisory, why it does not apply here, and the date by
 * which the reasoning has to be re-examined. An expired exception fails the
 * build exactly as an unreviewed advisory does, which is the point: an
 * exception is a deferral, not a dismissal.
 *
 *   node scripts/audit-check.mjs
 *   node scripts/audit-check.mjs --list   # print what is currently accepted
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

/** Advisories assessed and knowingly accepted, each with an expiry. */
const ACCEPTED = [
  {
    advisory: 'GHSA-ggr8-5vv4-36mx',
    package: 'deepmerge-ts',
    reachedVia: '@prisma/config ← prisma (the CLI)',
    severity: 'high',
    review: '2026-12-31',
    why: [
      'Stack exhaustion when deep-merging a recursive object graph. The only',
      'graph deepmerge-ts ever sees here is the Prisma CLI merging its own',
      'configuration file — a file in this repository, written by us, read at',
      'migrate and generate time. No request, upload or database row reaches',
      'it, so there is no input an attacker controls.',
      '',
      'It is also unfixable today rather than merely unfixed: the advisory is',
      'resolved in prisma 8.1.0 and the newest published prisma is an 8.0.0',
      'release candidate. Shipping a release-candidate ORM to hold employee',
      'payroll would be a far larger risk than the flaw it closes.',
      '',
      'Revisit when prisma 8.x is stable; upgrading is then ordinary work.',
    ].join('\n'),
  },
];

const listOnly = process.argv.includes('--list');

if (listOnly) {
  print(ACCEPTED);
  process.exit(0);
}

const BLOCKING = new Set(['high', 'critical']);

/** `npm audit` exits non-zero when it finds anything, so the throw is expected. */
function audit() {
  try {
    return JSON.parse(execFileSync('npm', ['audit', '--json'], { encoding: 'utf8' }));
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.length > 0) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

const report = audit();
const today = new Date().toISOString().slice(0, 10);

const accepted = new Map(ACCEPTED.map((entry) => [entry.advisory, entry]));
const used = new Set();
const blocking = [];
const expired = [];

for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
  if (!BLOCKING.has(vulnerability.severity)) continue;

  // `via` holds either advisory objects or the names of packages that pull
  // one in. Only the objects carry an id; a package named here is reported
  // under its own entry, so it is not lost by being skipped.
  for (const via of vulnerability.via) {
    if (typeof via !== 'object') continue;

    const exception = accepted.get(via.url?.split('/').pop() ?? '');
    if (!exception) {
      blocking.push({ name, severity: vulnerability.severity, title: via.title, url: via.url });
      continue;
    }

    used.add(exception.advisory);
    if (exception.review < today) {
      expired.push({ ...exception, expiredOn: exception.review });
    }
  }
}

/* An exception nobody needs any more is itself a problem: it would silently
 * accept the advisory again if it ever came back. */
const stale = ACCEPTED.filter((entry) => !used.has(entry.advisory));

let failed = false;

if (blocking.length > 0) {
  failed = true;
  console.error('\nBlocking advisories (high or critical, not accepted):\n');
  for (const item of dedupe(blocking)) {
    console.error(`  ${item.severity.padEnd(8)} ${item.name}`);
    console.error(`           ${item.title}`);
    console.error(`           ${item.url}\n`);
  }
  console.error('Fix them, or add an assessed exception to scripts/audit-check.mjs.\n');
}

if (expired.length > 0) {
  failed = true;
  console.error('\nAccepted advisories whose review date has passed:\n');
  for (const item of expired) {
    console.error(`  ${item.package} (${item.advisory}) — due ${item.expiredOn}`);
  }
  console.error('\nRe-assess and either fix them or move the date, with a reason.\n');
}

if (stale.length > 0) {
  failed = true;
  console.error('\nExceptions that match nothing in the current tree:\n');
  for (const item of stale) {
    console.error(`  ${item.package} (${item.advisory})`);
  }
  console.error('\nThe advisory is gone; remove the exception.\n');
}

if (!failed) {
  const counts = report.metadata?.vulnerabilities ?? {};
  console.log(
    `No blocking advisories. ` +
      `(${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ` +
      `${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low; ` +
      `${ACCEPTED.length} accepted with a review date.)`,
  );
  if (ACCEPTED.length > 0) print(ACCEPTED);
}

process.exit(failed ? 1 : 0);

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.name}:${item.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function print(entries) {
  for (const entry of entries) {
    console.log(`\n  ${entry.package} — ${entry.severity} — ${entry.advisory}`);
    console.log(`  reached via ${entry.reachedVia}`);
    console.log(`  review by ${entry.review}\n`);
    for (const line of entry.why.split('\n')) console.log(`    ${line}`);
  }
  console.log('');
}
