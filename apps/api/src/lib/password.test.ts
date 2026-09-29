import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  PASSWORD_MIN_LENGTH,
  checkPasswordPolicy,
  hashPassword,
  isBreachedPassword,
  needsRehash,
  verifyPassword,
} from './password.js';

const PEPPER = 'a-server-side-pepper-of-sufficient-length-1234';

describe('hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple', PEPPER);
    expect(await verifyPassword('correct horse battery staple', hash, PEPPER)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple', PEPPER);
    expect(await verifyPassword('correct horse battery stapler', hash, PEPPER)).toBe(false);
  });

  it('will not verify without the server pepper', async () => {
    const hash = await hashPassword('correct horse battery staple', PEPPER);
    expect(await verifyPassword('correct horse battery staple', hash, 'wrong-pepper')).toBe(false);
  });

  it('produces a different hash each time for the same password', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same password here', PEPPER),
      hashPassword('same password here', PEPPER),
    ]);
    expect(a).not.toBe(b);
  });

  it('uses argon2id with the configured cost', async () => {
    const hash = await hashPassword('some password value', PEPPER);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  });

  it('returns false rather than throwing on a corrupted hash', async () => {
    expect(await verifyPassword('anything', 'not-a-hash', PEPPER)).toBe(false);
    expect(await verifyPassword('anything', '', PEPPER)).toBe(false);
  });

  it('accepts a very long password without a denial-of-service risk', async () => {
    const long = 'x'.repeat(100_000);
    const hash = await hashPassword(long, PEPPER);
    expect(await verifyPassword(long, hash, PEPPER)).toBe(true);
  });

  it('flags a hash made with weaker parameters for rehashing', () => {
    expect(needsRehash('$argon2id$v=19$m=19456,t=2,p=1$abc$def')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=65536,t=3,p=1$abc$def')).toBe(false);
    expect(needsRehash('$2b$12$somethingbcrypt')).toBe(true);
  });
});

describe('policy', () => {
  it('accepts a long passphrase with no composition rules', () => {
    expect(checkPasswordPolicy('the quiet mountain sings')).toEqual([]);
  });

  it('rejects anything shorter than the minimum', () => {
    const problems = checkPasswordPolicy('x'.repeat(PASSWORD_MIN_LENGTH - 1));
    expect(problems.map((p) => p.rule)).toContain('too_short');
  });

  it('rejects a password containing the person’s own details', () => {
    const problems = checkPasswordPolicy('priya-raghavan-2026', [
      'Priya Raghavan',
      'priya.raghavan',
      'WDT-01847',
    ]);
    expect(problems.map((p) => p.rule)).toContain('contains_personal_data');
  });

  it('rejects keyboard walks and dictionary staples', () => {
    for (const bad of ['qwertyuiopas', 'mypassword123', 'widedrop2026!']) {
      expect(
        checkPasswordPolicy(bad).map((p) => p.rule),
        bad,
      ).toContain('common_sequence');
    }
  });

  it('rejects a repeated pattern', () => {
    expect(checkPasswordPolicy('abcabcabcabc').map((p) => p.rule)).toContain('too_repetitive');
    expect(checkPasswordPolicy('aaaaaaaaaaaaaa').map((p) => p.rule)).toContain('too_repetitive');
  });

  it('gives an explanation a person can act on', () => {
    for (const problem of checkPasswordPolicy('short')) {
      expect(problem.message.length).toBeGreaterThan(20);
    }
  });
});

describe('breach check', () => {
  const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').toUpperCase();

  it('sends only the first five hash characters, never the password', async () => {
    const password = 'correct horse battery staple';
    const digest = sha1(password);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      expect(href).toBe(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`);
      expect(href).not.toContain(password);
      expect(href).not.toContain(digest.slice(5));
      return new Response(`${digest.slice(5)}:42\r\n`, { status: 200 });
    });

    expect(
      await isBreachedPassword(password, { timeoutMs: 1000, fetchImpl: fetchImpl as never }),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('reports a password absent from the range as not breached', async () => {
    const fetchImpl = async () =>
      new Response('0000000000000000000000000000000000A:9\r\n', { status: 200 });
    expect(
      await isBreachedPassword('a password not in the list', {
        timeoutMs: 1000,
        fetchImpl: fetchImpl as never,
      }),
    ).toBe(false);
  });

  it('ignores padding rows, which carry a count of zero', async () => {
    const digest = sha1('padded');
    const fetchImpl = async () => new Response(`${digest.slice(5)}:0\r\n`, { status: 200 });
    expect(
      await isBreachedPassword('padded', { timeoutMs: 1000, fetchImpl: fetchImpl as never }),
    ).toBe(false);
  });

  it('fails open when the service is unreachable, so nobody is locked out', async () => {
    const fetchImpl = async () => {
      throw new Error('network down');
    };
    expect(
      await isBreachedPassword('anything', { timeoutMs: 50, fetchImpl: fetchImpl as never }),
    ).toBe(false);
  });

  it('fails open on a non-200 response', async () => {
    const fetchImpl = async () => new Response('rate limited', { status: 429 });
    expect(
      await isBreachedPassword('anything', { timeoutMs: 50, fetchImpl: fetchImpl as never }),
    ).toBe(false);
  });
});
