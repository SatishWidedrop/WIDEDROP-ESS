import { execFileSync } from 'node:child_process';
import { PrismaClient } from '../generated/prisma/index.js';

/**
 * Integration-test database.
 *
 * Tests run against a real PostgreSQL instance, because most of what this
 * system guarantees — exclusion constraints, generated columns, the payroll
 * pipeline triggers, the append-only ledgers — lives in the database and cannot
 * be exercised by a mock.
 *
 * Each suite runs inside a transaction that is rolled back, so suites do not
 * see one another's rows and the database is left as it was found.
 */

const DEFAULT_URL =
  'postgresql://ess:ess_local_dev_only@127.0.0.1:5433/widedrop_ess_test?schema=ess';

/**
 * The database the suite is allowed to destroy.
 *
 * `resetTestDb` truncates every table, so pointing this at a working database
 * loses that database's contents. It therefore refuses anything whose database
 * name does not end in `_test`, and it does **not** fall back to
 * `DATABASE_URL` — which once meant running the suite wiped the developer's
 * own data, with no error and nothing to suggest what had happened.
 *
 * `DATABASE_URL` is still honoured as a *source of connection details*: its
 * host, port and credentials are reused with `_test` appended to the database
 * name, so a developer with a non-default setup does not have to configure a
 * second variable.
 */
export function testDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL;
  if (explicit) return assertTestDatabase(explicit);

  const development = process.env.DATABASE_URL;
  if (!development) return DEFAULT_URL;

  const url = new URL(development);
  const name = url.pathname.replace(/^\//, '');
  url.pathname = `/${name.endsWith('_test') ? name : `${name}_test`}`;
  return assertTestDatabase(url.toString());
}

function assertTestDatabase(candidate: string): string {
  const name = new URL(candidate).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against "${name}": this suite truncates every table, ` +
        'so its database name must end in `_test`. Set TEST_DATABASE_URL.',
    );
  }
  return candidate;
}

let prisma: PrismaClient | undefined;

export function testDb(): PrismaClient {
  prisma ??= new PrismaClient({ datasourceUrl: testDatabaseUrl(), log: ['error'] });
  return prisma;
}

export async function closeTestDb(): Promise<void> {
  await prisma?.$disconnect();
  prisma = undefined;
}

/**
 * Apply migrations to the test database. Safe to call repeatedly.
 *
 * Both variables are set, not just `DATABASE_URL`. The schema declares a
 * `directUrl` for Supabase's pooler — migrations cannot run through a
 * transaction-mode pooler — and `prisma migrate` follows `directUrl` when it
 * is present. Setting only `DATABASE_URL` therefore pointed the suite's
 * migrations at whatever `DIRECT_DATABASE_URL` happened to hold, which on a
 * developer's machine is their own database: migrations landed there while the
 * test database quietly stayed behind, and the first symptom was a column the
 * schema knew about and the database did not.
 */
export function migrateTestDb(): void {
  const url = testDatabaseUrl();
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url },
    stdio: 'pipe',
  });
}

/**
 * Remove every operational row, leaving the schema intact.
 *
 * `TRUNCATE` is blocked on the append-only tables by design, so they are cleared
 * with a session-local flag the guard honours — the guard stays in force for
 * every other connection, including the application's.
 */
export async function resetTestDb(db: PrismaClient = testDb()): Promise<void> {
  const tables = await db.$queryRaw<{ table_schema: string; table_name: string }[]>`
    SELECT table_schema, table_name
      FROM information_schema.tables
     WHERE table_schema IN ('ess', 'ess_ops')
       AND table_type = 'BASE TABLE'
       AND table_name <> '_prisma_migrations'
  `;

  if (tables.length === 0) return;

  const list = tables.map((t) => `"${t.table_schema}"."${t.table_name}"`).join(', ');

  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`),
    db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`),
  ]);
}
