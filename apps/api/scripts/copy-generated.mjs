#!/usr/bin/env node
/**
 * Copy the generated Prisma client into `dist`.
 *
 * The client is generated to `src/generated/prisma` (see the `generator` block
 * in prisma/schema.prisma), and the code imports it by relative path —
 * `../../generated/prisma/index.js`. After `tsc`, the compiled module in
 * `dist/services/auth/login.js` resolves that to `dist/generated/prisma`,
 * which tsc never creates: the generated client is JavaScript, a `.wasm` and a
 * native `.node` engine, and tsc emits only what it compiles.
 *
 * So `node dist/server.js` fails at its first import with MODULE_NOT_FOUND —
 * not at build time, not in any test that runs from source, but on the first
 * container that tries to start. This copy is what makes `dist` a tree that
 * can actually run.
 *
 * Run as the last step of `npm run build -w @widedrop/api`.
 */
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(apiRoot, 'src/generated');
const to = resolve(apiRoot, 'dist/generated');

if (!existsSync(from)) {
  console.error(
    `No generated Prisma client at ${from}.\n` +
      'Run `npm run db:generate -w @widedrop/api` before building.',
  );
  process.exit(1);
}

cpSync(from, to, { recursive: true });

// The native query engine is the part that is easy to lose and impossible to
// work around: without it the client throws at its first query rather than at
// import, which is a much worse place to find out.
const engines = readdirSync(resolve(to, 'prisma')).filter((name) => name.endsWith('.node'));
if (engines.length === 0) {
  console.error(
    `Copied the client to ${to} but it carries no query engine (*.node).\n` +
      'Check `binaryTargets` in prisma/schema.prisma against the build platform.',
  );
  process.exit(1);
}

console.log(`copied the generated Prisma client to dist/generated (engine: ${engines.join(', ')})`);
