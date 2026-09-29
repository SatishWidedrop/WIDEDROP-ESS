import { hash as argon2Hash, verify as argon2Verify, Algorithm } from '@node-rs/argon2';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing and policy.
 *
 * Argon2id with parameters chosen to cost roughly 100ms on the production
 * container — enough to make offline cracking expensive, cheap enough that a
 * sign-in does not feel slow. A server-side pepper is mixed in before hashing,
 * so a stolen database alone cannot be attacked offline: the attacker also needs
 * the application secret.
 */

/**
 * OWASP's current Argon2id guidance is 19 MiB / t=2 / p=1. We take memory up to
 * 64 MiB, which is comfortably affordable on the API container and raises the
 * cost of a GPU attack substantially.
 */
export const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} as const;

/**
 * Pre-hash the password with the server pepper.
 *
 * Argon2 has no pepper parameter, so pre-hashing with the secret is the standard
 * construction: a stolen database cannot be attacked offline without also
 * stealing the application secret. Pre-hashing to a fixed length additionally
 * removes the denial-of-service risk of a megabyte-long password being fed
 * straight into a memory-hard function.
 *
 * The digest is base64-encoded rather than passed as raw bytes: argon2's verify
 * requires valid UTF-8, which a raw SHA-512 digest is not. Base64 is ASCII, so
 * it round-trips through both hash and verify while keeping all 512 bits.
 */
function pepper(password: string, serverPepper: string): string {
  return createHash('sha512')
    .update(serverPepper, 'utf8')
    .update(SEPARATOR)
    .update(password, 'utf8')
    .digest('base64');
}

/** A byte that cannot occur in the UTF-8 pepper, so the two inputs cannot be confused. */
const SEPARATOR = Buffer.from([0x00]);

export async function hashPassword(password: string, serverPepper: string): Promise<string> {
  return argon2Hash(pepper(password, serverPepper), ARGON2_OPTIONS);
}

/**
 * Verify a password. Returns false rather than throwing on a malformed hash, so
 * a corrupted row cannot be distinguished from a wrong password by timing or by
 * error message.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
  serverPepper: string,
): Promise<boolean> {
  try {
    return await argon2Verify(storedHash, pepper(password, serverPepper));
  } catch {
    return false;
  }
}

/**
 * True when a stored hash was produced with weaker parameters than the current
 * ones and should be re-hashed on the next successful sign-in.
 */
export function needsRehash(storedHash: string): boolean {
  const match = /\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!match) return true;
  const [, m, t, p] = match;
  return (
    Number(m) < ARGON2_OPTIONS.memoryCost ||
    Number(t) < ARGON2_OPTIONS.timeCost ||
    Number(p) < ARGON2_OPTIONS.parallelism
  );
}

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

/**
 * Length is the only composition rule. Character-class requirements push people
 * towards `Password1!` and are explicitly discouraged by NIST SP 800-63B; a
 * breach check does far more good.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export interface PasswordProblem {
  rule:
    | 'too_short'
    | 'too_long'
    | 'breached'
    | 'contains_personal_data'
    | 'too_repetitive'
    | 'common_sequence';
  message: string;
}

/** Sequences that appear in every cracking dictionary. */
const SEQUENCES = [
  'qwerty', 'asdfgh', 'zxcvbn', '123456', '098765', 'abcdef', 'password',
  'letmein', 'welcome', 'admin', 'widedrop', 'payroll',
];

/**
 * Check a password against everything we can judge locally. The breach check is
 * separate because it needs the network — see `isBreachedPassword`.
 *
 * `personalData` is the set of strings that must not appear in the password:
 * the person's name, their email local part, their employee code.
 */
export function checkPasswordPolicy(
  password: string,
  personalData: readonly string[] = [],
): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  const lower = password.toLowerCase();

  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push({
      rule: 'too_short',
      message: `Use at least ${PASSWORD_MIN_LENGTH} characters. A short phrase you will remember beats a short jumble you will not.`,
    });
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push({
      rule: 'too_long',
      message: `Keep it under ${PASSWORD_MAX_LENGTH} characters.`,
    });
  }

  // Compare on letters and digits only, so `priya-raghavan-2026` is still
  // recognised as containing "Priya Raghavan", and check each token separately
  // so a first name alone is caught too.
  const alphanumeric = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const passwordKey = alphanumeric(password);
  const tokens = new Set(
    personalData.flatMap((value) => [value, ...value.split(/[\s@._-]+/)]).map(alphanumeric),
  );

  for (const token of tokens) {
    if (token.length >= 4 && passwordKey.includes(token)) {
      problems.push({
        rule: 'contains_personal_data',
        message: 'Do not include your name, email or employee ID in your password.',
      });
      break;
    }
  }

  for (const sequence of SEQUENCES) {
    if (lower.includes(sequence)) {
      problems.push({
        rule: 'common_sequence',
        message: 'This contains a sequence that appears in every password-cracking list.',
      });
      break;
    }
  }

  // A single character repeated, or a short pattern tiled to length.
  if (/^(.)\1+$/.test(password) || (password.length >= 8 && /^(.{1,3}?)\1{3,}$/.test(password))) {
    problems.push({
      rule: 'too_repetitive',
      message: 'This is a short pattern repeated. Use something with more variety.',
    });
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/* Breach check (Have I Been Pwned, k-anonymity)                       */
/* ------------------------------------------------------------------ */

/**
 * Ask HIBP whether this password appears in a known breach, without ever
 * sending the password or its full hash: only the first five characters of the
 * SHA-1 digest go over the wire, and the response is a list of suffixes we
 * search locally.
 *
 * A network failure returns `false` — "not known to be breached". Refusing to
 * let anyone set a password because a third party is down would be a worse
 * outcome than missing one breached password, and the local policy still applies.
 */
export async function isBreachedPassword(
  password: string,
  options: { timeoutMs: number; fetchImpl?: typeof fetch } = { timeoutMs: 2_000 },
): Promise<boolean> {
  const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);

  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await doFetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      signal: controller.signal,
      headers: { 'Add-Padding': 'true', 'User-Agent': 'widedrop-ess' },
    });
    if (!response.ok) return false;

    const body = await response.text();
    for (const line of body.split('\n')) {
      const candidate = line.slice(0, 35).trim();
      if (candidate.length !== suffix.length) continue;
      if (
        timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(suffix, 'utf8')) &&
        // Padding rows are returned with a count of 0 and must be ignored.
        Number(line.slice(36).trim()) > 0
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
