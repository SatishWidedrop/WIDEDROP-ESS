import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import type { App } from '../../app.js';
import { buildTestApp, testEnv } from '../../test/app.js';
import { closeTestDb, resetTestDb, testDb } from '../../test/db.js';
import { hashPassword } from '../../lib/password.js';
import { createTotpEnrolment, TOTP_CONFIG } from '../../lib/mfa.js';
import { EncryptionService } from '../../services/encryption.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../../plugins/csrf.js';

const db = testDb();
const PASSWORD = 'the quiet mountain sings';
const ORIGIN = 'http://127.0.0.1:5173';

let app: App;
let organizationId: string;
let employeeRoleId: string;
let hrRoleId: string;

/**
 * A distinct address per test.
 *
 * The login limiter is keyed by the email being attempted and is deliberately
 * left switched on for these tests, so reusing one address across them would
 * trip it partway through the file — and the limiter working is itself
 * something worth proving, which the last describe block does.
 */
let addressCounter = 0;
const nextEmail = () => `priya${(addressCounter += 1)}@widedrop.test`;

beforeAll(async () => {
  app = await buildTestApp();
  await resetTestDb(db);
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);

  const org = await db.organization.create({
    data: {
      legalName: 'Widedrop Technologies Pvt Ltd',
      displayName: 'Widedrop',
      domain: 'widedrop.test',
      helpdeskEmail: 'helpdesk@widedroptech.com',
    },
  });
  organizationId = org.id;

  employeeRoleId = (
    await db.role.create({
      data: { persona: 'EMPLOYEE', name: 'Employee', description: 'Their own records.' },
    })
  ).id;
  hrRoleId = (
    await db.role.create({ data: { persona: 'HR', name: 'HR', description: 'People records.' } })
  ).id;
});

async function makeUser(
  input: { email?: string; code?: string; roleId?: string; withMfa?: boolean } = {},
) {
  const email = input.email ?? nextEmail();
  const code = input.code ?? `WDT-${addressCounter}`;
  const env = testEnv();
  const user = await db.appUser.create({
    data: {
      organizationId,
      email,
      status: 'ACTIVE',
      passwordHash: await hashPassword(PASSWORD, env.PASSWORD_PEPPER),
      passwordUpdatedAt: new Date(),
    },
    select: { id: true },
  });

  await db.employee.create({
    data: {
      organizationId,
      appUserId: user.id,
      employeeNumber: code,
      firstName: 'Priya',
      lastName: 'Raghavan',
      workEmail: email,
      dateOfJoining: new Date('2022-07-11'),
      employmentStatus: 'ACTIVE',
    },
  });

  await db.userRole.create({
    data: { appUserId: user.id, roleId: input.roleId ?? employeeRoleId },
  });

  let secret: string | undefined;
  if (input.withMfa) {
    const enrolment = createTotpEnrolment(email);
    secret = enrolment.secret;
    const credentialId = crypto.randomUUID();
    const encryption = new EncryptionService(env);
    const sealed = encryption.encrypt(
      enrolment.secret,
      EncryptionService.context('mfa_credential', 'secret', credentialId),
    );
    await db.mfaCredential.create({
      data: {
        id: credentialId,
        organizationId,
        appUserId: user.id,
        secretCt: sealed.ct,
        secretIv: sealed.iv,
        secretTag: sealed.tag,
        encryptionKeyVersion: sealed.keyVersion,
        confirmedAt: new Date(),
      },
    });
  }

  return { userId: user.id, email, secret };
}

const login = (email: string, password: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site' },
    payload: { email, password },
  });

describe('sign-in', () => {
  it('issues a session, a refresh cookie and a CSRF token', async () => {
    const { email } = await makeUser();
    const response = await login(email, PASSWORD);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.user).toMatchObject({
      email,
      displayName: 'Priya Raghavan',
      initials: 'PR',
      personas: ['EMPLOYEE'],
    });

    const cookies = response.cookies;
    const refresh = cookies.find((c) => c.name === 'ess_refresh');
    expect(refresh).toBeDefined();
    // The refresh token must not be readable by script.
    expect(refresh!.httpOnly).toBe(true);
    expect(refresh!.sameSite?.toLowerCase()).toBe('lax');
    // Scoped to the auth routes, so it is not sent with every API call.
    expect(refresh!.path).toBe('/api/v1/auth');

    // The CSRF token must be readable, which is the point of double-submit.
    const csrf = cookies.find((c) => c.name === CSRF_COOKIE);
    expect(csrf).toBeDefined();
    expect(csrf!.httpOnly).toBeFalsy();
    expect(body.csrfToken).toBe(csrf!.value);
  });

  it('never returns the refresh token in the body', async () => {
    const { email } = await makeUser();
    const response = await login(email, PASSWORD);
    const refresh = response.cookies.find((c) => c.name === 'ess_refresh')!;
    expect(response.body).not.toContain(refresh.value);
  });

  it('gives the same answer for a wrong password and an unknown address', async () => {
    const { email } = await makeUser();

    const wrong = await login(email, 'not the password');
    const unknown = await login('nobody@widedrop.test', PASSWORD);

    expect(wrong.statusCode).toBe(unknown.statusCode);
    expect(wrong.json().error.code).toBe(unknown.json().error.code);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
  });

  it('rejects a malformed request without saying what is wrong with the password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site' },
      payload: { email: 'not-an-email', password: PASSWORD },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(PASSWORD);
  });

  it('rejects unknown fields rather than ignoring them', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site' },
      payload: { email: 'anyone@widedrop.test', password: PASSWORD, personas: ['HR'] },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('the session it issues', () => {
  it('is accepted on an authenticated route', async () => {
    const { email } = await makeUser();
    const { accessToken } = (await login(email, PASSWORD)).json();

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      email,
      displayName: 'Priya Raghavan',
      personas: ['EMPLOYEE'],
    });
  });

  it('is refused without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('is refused with a tampered token', async () => {
    const { email } = await makeUser();
    const { accessToken } = (await login(email, PASSWORD)).json();

    // Flip a character in the signature.
    const tampered = `${accessToken.slice(0, -2)}${accessToken.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('stops working the moment the token epoch moves', async () => {
    const { userId, email } = await makeUser();
    const { accessToken } = (await login(email, PASSWORD)).json();

    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: { authorization: `Bearer ${accessToken}` },
        })
      ).statusCode,
    ).toBe(200);

    // What "sign out everywhere" does.
    await db.appUser.update({ where: { id: userId }, data: { tokenEpoch: { increment: 1 } } });

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('SESSION_EXPIRED');
  });

  it('stops working the moment the account is suspended', async () => {
    const { userId, email } = await makeUser();
    const { accessToken } = (await login(email, PASSWORD)).json();

    await db.employee.updateMany({
      where: { appUserId: userId },
      data: { employmentStatus: 'SUSPENDED' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('refresh', () => {
  it('rotates the token and issues a new one', async () => {
    const { email } = await makeUser();
    const first = await login(email, PASSWORD);
    const firstRefresh = first.cookies.find((c) => c.name === 'ess_refresh')!.value;

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        origin: ORIGIN,
        'sec-fetch-site': 'same-site',
        cookie: `ess_refresh=${firstRefresh}`,
      },
    });

    expect(refreshed.statusCode).toBe(200);
    const secondRefresh = refreshed.cookies.find((c) => c.name === 'ess_refresh')!.value;
    expect(secondRefresh).not.toBe(firstRefresh);
    expect(refreshed.json().accessToken).toBeTypeOf('string');
  });

  it('revokes the whole family when a rotated token is presented again', async () => {
    const { userId, email } = await makeUser();
    const first = await login(email, PASSWORD);
    const stolen = first.cookies.find((c) => c.name === 'ess_refresh')!.value;

    // The legitimate client refreshes.
    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site', cookie: `ess_refresh=${stolen}` },
    });
    const live = rotated.cookies.find((c) => c.name === 'ess_refresh')!.value;

    // A thief uses the copy they took earlier.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site', cookie: `ess_refresh=${stolen}` },
    });

    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('TOKEN_REUSE_DETECTED');

    // The legitimate token is gone too: the family is compromised.
    const afterward = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site', cookie: `ess_refresh=${live}` },
    });
    expect(afterward.statusCode).toBe(401);

    // And the owner is told.
    const alert = await db.notification.findFirst({
      where: { appUserId: userId, kind: 'SECURITY_ALERT' },
    });
    expect(alert?.title).toContain('signed out');
  });

  it('refuses an unknown token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site', cookie: 'ess_refresh=nonsense' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('two-factor authentication', () => {
  const codeFor = (secret: string, label: string) =>
    new OTPAuth.TOTP({
      issuer: TOTP_CONFIG.issuer,
      label,
      algorithm: TOTP_CONFIG.algorithm,
      digits: TOTP_CONFIG.digits,
      period: TOTP_CONFIG.period,
      secret: OTPAuth.Secret.fromBase32(secret),
    }).generate();

  it('stops at a challenge rather than issuing a session', async () => {
    const { email } = await makeUser({ withMfa: true });
    const response = await login(email, PASSWORD);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('mfa-required');
    expect(body.accessToken).toBeUndefined();
    expect(response.cookies.find((c) => c.name === 'ess_refresh')).toBeUndefined();
  });

  it('issues a session once the code is verified', async () => {
    const { secret, email } = await makeUser({ withMfa: true });
    const { challengeId } = (await login(email, PASSWORD)).json();

    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site' },
      payload: { challengeId, code: codeFor(secret!, email) },
    });

    expect(verified.statusCode).toBe(200);
    expect(verified.json().accessToken).toBeTypeOf('string');
    expect(verified.cookies.find((c) => c.name === 'ess_refresh')).toBeDefined();
  });

  it('refuses a wrong code, and says nothing more', async () => {
    const { email } = await makeUser({ withMfa: true });
    const { challengeId } = (await login(email, PASSWORD)).json();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site' },
      payload: { challengeId, code: '000000' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_MFA_CODE');
  });

  it('will not accept the same code twice', async () => {
    const { secret, email } = await makeUser({ withMfa: true });
    const code = codeFor(secret!, email);

    const first = (await login(email, PASSWORD)).json();
    const firstVerify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site' },
      payload: { challengeId: first.challengeId, code },
    });
    expect(firstVerify.statusCode).toBe(200);

    // A second challenge, the same intercepted code, inside its window.
    const second = (await login(email, PASSWORD)).json();
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site' },
      payload: { challengeId: second.challengeId, code },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('will not reuse a challenge', async () => {
    const { secret, email } = await makeUser({ withMfa: true });
    const { challengeId } = (await login(email, PASSWORD)).json();

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site' },
      payload: { challengeId, code: codeFor(secret!, email) },
    });
    expect(first.statusCode).toBe(200);

    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site' },
      payload: { challengeId, code: codeFor(secret!, email) },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it('records a failed second factor as evidence', async () => {
    const { userId, email } = await makeUser({ withMfa: true });
    const { challengeId } = (await login(email, PASSWORD)).json();

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site' },
      payload: { challengeId, code: '123456' },
    });

    const attempt = await db.loginAttempt.findFirst({
      where: { appUserId: userId, outcome: 'MFA_FAILED' },
    });
    expect(attempt).not.toBeNull();
  });

  it('requires HR to enrol before a session is issued', async () => {
    const { email } = await makeUser({ roleId: hrRoleId });
    const response = await login(email, PASSWORD);
    expect(response.json()).toMatchObject({
      status: 'mfa-required',
      enrolmentRequired: true,
    });
  });
});

describe('changing a password', () => {
  const csrfHeaders = (csrfToken: string, accessToken: string) => ({
    origin: ORIGIN,
    'sec-fetch-site': 'same-site' as const,
    authorization: `Bearer ${accessToken}`,
    cookie: `${CSRF_COOKIE}=${csrfToken}`,
    [CSRF_HEADER]: csrfToken,
  });

  it('signs out everywhere, so a leaked password cannot keep a session alive', async () => {
    const { userId, email } = await makeUser();
    const { accessToken, csrfToken } = (await login(email, PASSWORD)).json();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: csrfHeaders(csrfToken, accessToken),
      payload: { currentPassword: PASSWORD, newPassword: 'a different quiet mountain' },
    });

    expect(response.statusCode).toBe(200);

    const live = await db.refreshToken.count({ where: { appUserId: userId, revokedAt: null } });
    expect(live).toBe(0);

    const alert = await db.notification.findFirst({
      where: { appUserId: userId, kind: 'SECURITY_ALERT' },
    });
    expect(alert?.title).toContain('password was changed');
  });

  it('refuses a wrong current password', async () => {
    const { email } = await makeUser();
    const { accessToken, csrfToken } = (await login(email, PASSWORD)).json();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: csrfHeaders(csrfToken, accessToken),
      payload: { currentPassword: 'wrong', newPassword: 'a different quiet mountain' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a new password containing the person’s own name', async () => {
    const { email } = await makeUser();
    const { accessToken, csrfToken } = (await login(email, PASSWORD)).json();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: csrfHeaders(csrfToken, accessToken),
      payload: { currentPassword: PASSWORD, newPassword: 'priya-raghavan-2026!' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toContain('name');
  });

  it('refuses reusing the current password', async () => {
    const { email } = await makeUser();
    const { accessToken, csrfToken } = (await login(email, PASSWORD)).json();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: csrfHeaders(csrfToken, accessToken),
      payload: { currentPassword: PASSWORD, newPassword: PASSWORD },
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('password reset', () => {
  it('answers the same way whether or not the address exists', async () => {
    const { email } = await makeUser();

    const known = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/request',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site' },
      payload: { email },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/request',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site' },
      payload: { email: 'nobody@widedrop.test' },
    });

    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.body).toBe(unknown.body);
  });

  it('queues the mail rather than sending it inline, so an outage loses nothing', async () => {
    const { email } = await makeUser();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset/request',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site' },
      payload: { email },
    });

    const queued = await db.emailOutbox.findFirstOrThrow({ where: { kind: 'PASSWORD_RESET' } });
    expect(queued.status).toBe('QUEUED');
    expect(queued.toAddresses).toEqual([email]);
  });
});

describe('signing out', () => {
  it('revokes this device only', async () => {
    const { userId, email } = await makeUser();
    const deviceA = (await login(email, PASSWORD)).json();
    const deviceB = (await login(email, PASSWORD)).json();

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        origin: ORIGIN,
        'sec-fetch-site': 'same-site',
        authorization: `Bearer ${deviceA.accessToken}`,
        cookie: `${CSRF_COOKIE}=${deviceA.csrfToken}`,
        [CSRF_HEADER]: deviceA.csrfToken,
      },
    });

    const live = await db.refreshToken.count({ where: { appUserId: userId, revokedAt: null } });
    expect(live).toBe(1);
    // The other device still works.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: { authorization: `Bearer ${deviceB.accessToken}` },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('revokes everywhere when asked to', async () => {
    const { userId, email } = await makeUser();
    const deviceA = (await login(email, PASSWORD)).json();
    await login(email, PASSWORD);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout-all',
      headers: {
        origin: ORIGIN,
        'sec-fetch-site': 'same-site',
        authorization: `Bearer ${deviceA.accessToken}`,
        cookie: `${CSRF_COOKIE}=${deviceA.csrfToken}`,
        [CSRF_HEADER]: deviceA.csrfToken,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().sessionsRevoked).toBe(2);
    expect(await db.refreshToken.count({ where: { appUserId: userId, revokedAt: null } })).toBe(0);
  });
});

describe('rate limiting', () => {
  it('stops repeated attempts against one address', async () => {
    const { email } = await makeUser();

    let limited = false;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const response = await login(email, 'wrong password');
      if (response.statusCode === 429) {
        limited = true;
        expect(response.headers['retry-after']).toBeDefined();
        break;
      }
    }

    expect(limited).toBe(true);
  });
});
