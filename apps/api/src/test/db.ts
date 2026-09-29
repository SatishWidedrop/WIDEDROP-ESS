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

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_URL;
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

/** Apply migrations to the test database. Safe to call repeatedly. */
export function migrateTestDb(): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
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
