import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, importPKCS8, importSPKI, jwtVerify, type JWTPayload, type KeyLike } from 'jose';
import type { Persona } from '@widedrop/shared';
import { AppError, ERROR_CODES } from '../../lib/errors.js';

/**
 * Access tokens.
 *
 * Short-lived, signed with Ed25519, and carrying only what an authorization
 * check needs. Deliberately *not* carrying the user's permissions: those are
 * resolved server-side per request from the roles that are current now, so a
 * revoked role stops working immediately rather than at the next expiry.
 *
 * Revocation is by epoch. Every token carries the user's `epc`; a password
 * change, a role change or "sign out everywhere" increments it and every token
 * issued before that moment stops verifying — without a per-request lookup of a
 * revocation list.
 */

export const TOKEN_ISSUER = 'widedrop-ess';
export const TOKEN_AUDIENCE = 'widedrop-ess-api';
const ALGORITHM = 'EdDSA';

/**
 * Clock skew tolerated between the signer and the verifier. Small, because both
 * are our own processes; not zero, because container clocks drift.
 */
const CLOCK_TOLERANCE_SECONDS = 5;

export interface AccessTokenClaims {
  /** Subject: the app_user id. */
  sub: string;
  /** Organisation, so a token cannot be replayed against another tenant. */
  org: string;
  /** Employee id, absent for a service account with no employee record. */
  emp?: string;
  /** The personas held at issue time. Re-checked against the database per request. */
  roles: Persona[];
  /** Session id: the refresh-token family this access token belongs to. */
  sid: string;
  /** Token epoch. A mismatch against the stored value is an immediate 401. */
  epc: number;
  /** True once the second factor has been satisfied for this session. */
  mfa: boolean;
}

export interface TokenKeys {
  privateKey: KeyLike;
  publicKey: KeyLike;
  keyId: string;
}

/**
 * Load the signing keys.
 *
 * Keys are supplied base64-encoded so a PEM survives an environment variable
 * intact, newlines and all.
 */
export async function loadTokenKeys(input: {
  privateKeyBase64: string;
  publicKeyBase64: string;
  keyId: string;
}): Promise<TokenKeys> {
  const privatePem = Buffer.from(input.privateKeyBase64, 'base64').toString('utf8');
  const publicPem = Buffer.from(input.publicKeyBase64, 'base64').toString('utf8');

  if (!privatePem.includes('PRIVATE KEY') || !publicPem.includes('PUBLIC KEY')) {
    throw new Error(
      'JWT keys must be base64-encoded PEM. Generate a pair with:\n' +
        '  openssl genpkey -algorithm ed25519 -out private.pem\n' +
        '  openssl pkey -in private.pem -pubout -out public.pem',
    );
  }

  return {
    privateKey: await importPKCS8(privatePem, ALGORITHM),
    publicKey: await importSPKI(publicPem, ALGORITHM),
    keyId: input.keyId,
  };
}

/** Generate a development key pair. Never used in production, where keys are supplied. */
export function generateDevelopmentKeyPair(): {
  privateKeyBase64: string;
  publicKeyBase64: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyBase64: Buffer.from(
      privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    ).toString('base64'),
    publicKeyBase64: Buffer.from(
      publicKey.export({ type: 'spki', format: 'pem' }) as string,
    ).toString('base64'),
  };
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  keys: TokenKeys,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return (
    new SignJWT({
      org: claims.org,
      ...(claims.emp ? { emp: claims.emp } : {}),
      roles: claims.roles,
      sid: claims.sid,
      epc: claims.epc,
      mfa: claims.mfa,
    })
      .setProtectedHeader({ alg: ALGORITHM, kid: keys.keyId, typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + ttlSeconds)
      // A unique id per token, so a replay can be recognised if one is ever seen twice.
      .setJti(crypto.randomUUID())
      .sign(keys.privateKey)
  );
}

/**
 * Verify and decode. Every failure produces the same error, so a caller cannot
 * distinguish an expired token from a forged one and probe for a valid shape.
 */
export async function verifyAccessToken(
  token: string,
  keys: TokenKeys,
): Promise<AccessTokenClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys.publicKey, {
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      algorithms: [ALGORITHM],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      // `none` and algorithm-confusion attacks rely on the verifier accepting
      // whatever the header says; pinning the algorithm closes that.
      requiredClaims: ['sub', 'org', 'sid', 'epc'],
    }));
  } catch {
    throw new AppError(
      401,
      ERROR_CODES.SESSION_EXPIRED,
      'Your session has expired. Sign in again.',
    );
  }

  const claims = parseClaims(payload);
  if (!claims) {
    throw new AppError(
      401,
      ERROR_CODES.SESSION_EXPIRED,
      'Your session has expired. Sign in again.',
    );
  }
  return claims;
}

function parseClaims(payload: JWTPayload): AccessTokenClaims | undefined {
  const { sub, org, emp, roles, sid, epc, mfa } = payload as Record<string, unknown>;
  if (typeof sub !== 'string' || typeof org !== 'string' || typeof sid !== 'string')
    return undefined;
  if (typeof epc !== 'number' || !Number.isInteger(epc)) return undefined;
  if (!Array.isArray(roles) || roles.some((r) => typeof r !== 'string')) return undefined;

  return {
    sub,
    org,
    ...(typeof emp === 'string' ? { emp } : {}),
    roles: roles as Persona[],
    sid,
    epc,
    mfa: mfa === true,
  };
}

/**
 * Read the bearer token from an Authorization header.
 *
 * Access tokens travel in a header, not a cookie: a token the browser attaches
 * automatically is a token a cross-site request can spend. Keeping it in
 * memory and sending it explicitly means CSRF cannot reach an authenticated
 * endpoint at all.
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header.trim());
  return match?.[1];
}
