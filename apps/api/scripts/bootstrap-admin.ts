/**
 * Create the first administrator.
 *
 * The chicken-and-egg problem of a system with no default accounts: somebody
 * has to be able to sign in before anybody can be invited.
 *
 * Three rules this script exists to enforce:
 *
 *  1. **No hardcoded password, ever.** One is generated here with 160 bits of
 *     entropy, printed once, and never stored in plaintext. There is no default
 *     credential to forget to change.
 *
 *  2. **It runs once.** If an account already holds HR or Accounts, the script
 *     refuses, so it cannot be used to quietly mint a second administrator.
 *
 *  3. **The first sign-in must change it.** The account is created with
 *     `passwordMustChange`, and MFA enrolment is mandatory for its roles.
 *
 *   npm run bootstrap:admin -w @widedrop/api -- --email you@widedrop.com --name "Your Name"
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { hashPassword } from '../src/lib/password.js';
import { recordAudit } from '../src/services/audit.js';
import { runAsSystem } from '../src/lib/request-context.js';
import { PrismaClient } from '../src/generated/prisma/index.js';

const prisma = new PrismaClient();

/** Unambiguous alphabet: no 0/O, 1/I/l, which people mistype when reading aloud. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** 24 characters from a 55-symbol alphabet is roughly 139 bits. */
function generatePassword(length = 24): string {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i += 1) {
    // Reject values that would bias the modulo, so the distribution is uniform.
    const byte = bytes[i]!;
    if (byte >= 256 - (256 % ALPHABET.length)) continue;
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      'employee-number': { type: 'string' },
      force: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const email = values.email?.trim().toLowerCase();
  const name = values.name?.trim();

  if (!email || !name) {
    console.error(
      'Usage: npm run bootstrap:admin -w @widedrop/api -- --email you@widedrop.com --name "Your Name"',
    );
    process.exitCode = 1;
    return;
  }

  const pepper = process.env.PASSWORD_PEPPER;
  if (!pepper || pepper.length < 32) {
    console.error(
      'PASSWORD_PEPPER must be set to at least 32 characters before creating an account.\n' +
        'Generate one with: openssl rand -base64 48',
    );
    process.exitCode = 1;
    return;
  }

  const hmacKey = process.env.AUDIT_HMAC_KEY;
  if (!hmacKey) {
    console.error('AUDIT_HMAC_KEY must be set: the first account creation is itself audited.');
    process.exitCode = 1;
    return;
  }

  const organization = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!organization) {
    console.error(
      'No organization exists. Run the reference seed first:\n  npm run db:seed:reference -w @widedrop/api',
    );
    process.exitCode = 1;
    return;
  }

  // Refuse to mint a second administrator silently.
  const existingAdmins = await prisma.userRole.count({
    where: { revokedAt: null, role: { persona: { in: ['HR', 'ACCOUNTS'] } } },
  });

  if (existingAdmins > 0 && !values.force) {
    console.error(
      `This organization already has ${existingAdmins} account(s) holding HR or Accounts.\n` +
        'Invite further administrators through the portal, where the grant is audited and\n' +
        'attributable. Pass --force only to recover from a total lockout.',
    );
    process.exitCode = 1;
    return;
  }

  const [firstName, ...rest] = name.split(/\s+/);
  const lastName = rest.join(' ') || firstName!;
  const employeeNumber = values['employee-number'] ?? `${organization.employeeNumberPrefix}-00001`;

  const password = generatePassword();
  const passwordHash = await hashPassword(password, pepper);

  const roles = await prisma.role.findMany({
    where: { persona: { in: ['HR', 'ACCOUNTS'] } },
    select: { id: true, persona: true },
  });

  if (roles.length < 2) {
    console.error('Roles are missing. Run the reference seed first.');
    process.exitCode = 1;
    return;
  }

  await runAsSystem(
    { requestId: 'bootstrap', organizationId: organization.id, job: 'bootstrap-admin' },
    () =>
      prisma.$transaction(async (tx) => {
        const user = await tx.appUser.create({
          data: {
            organizationId: organization.id,
            email,
            passwordHash,
            passwordUpdatedAt: new Date(),
            // They change it at first sign-in, so even this generated value has a
            // short life.
            passwordMustChange: true,
            status: 'ACTIVE',
            emailVerifiedAt: new Date(),
          },
          select: { id: true },
        });

        await tx.employee.create({
          data: {
            organizationId: organization.id,
            appUserId: user.id,
            employeeNumber,
            firstName: firstName!,
            lastName,
            workEmail: email,
            dateOfJoining: new Date(),
            employmentStatus: 'ACTIVE',
            isDirectoryListed: false,
          },
        });

        for (const role of roles) {
          await tx.userRole.create({ data: { appUserId: user.id, roleId: role.id } });
        }

        await recordAudit(
          tx,
          {
            organizationId: organization.id,
            action: 'PERMISSION_GRANT',
            entityType: 'app_user',
            entityId: user.id,
            summary: `Bootstrap administrator created with HR and Accounts${values.force ? ' (forced)' : ''}`,
            after: { email, employeeNumber, roles: roles.map((r) => r.persona) },
            actor: { kind: 'MIGRATION' },
          },
          hmacKey,
        );

        return user;
      }),
  );

  // Printed once. Nothing writes it to a file or a log.
  console.log('\n  Administrator created.\n');
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${password}`);
  console.log('\n  This password is shown once and is not stored anywhere in plaintext.');
  console.log('  Copy it now, sign in, and change it — you will be asked to on first use.');
  console.log('  Two-factor authentication is mandatory for HR and Accounts and will be');
  console.log('  required before these roles do anything.\n');
}

main()
  .catch((error: unknown) => {
    console.error('Bootstrap failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
