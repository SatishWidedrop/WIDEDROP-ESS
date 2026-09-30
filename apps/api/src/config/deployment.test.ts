import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS, loadEnv } from './env.js';

/**
 * The deployment artifacts, checked against the validator they have to satisfy.
 *
 * `loadEnv` refuses to start the process on a missing or unsafe value, which is
 * the behaviour we want — but it means a variable misnamed in the Render
 * blueprint surfaces as a service that will not boot, at the end of a deploy,
 * with two instances already torn down. That is the worst possible moment to
 * discover it, and it has happened here once already: the blueprint said
 * `STORAGE_BUCKET` where the validator reads `S3_BUCKET`.
 *
 * So the blueprint is parsed and fed to the real validator in production mode.
 * A variable that the API needs and the blueprint does not promise fails here,
 * on the pull request, where it costs nothing.
 */

const repoRoot = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, repoRoot)), 'utf8');

interface RenderEnvVar {
  key?: string;
  value?: string | number;
  sync?: boolean;
  fromGroup?: string;
  fromDatabase?: unknown;
  fromService?: unknown;
}

interface RenderBlueprint {
  services: {
    type: string;
    name: string;
    envVars?: RenderEnvVar[];
    dockerfilePath?: string;
    dockerContext?: string;
    dockerCommand?: string;
  }[];
  envVarGroups?: { name: string; envVars: RenderEnvVar[] }[];
}

const blueprint = load(read('infra/render/render.yaml')) as RenderBlueprint;

/**
 * Every variable a service ends up with, following `fromGroup`.
 *
 * A value the dashboard supplies (`sync: false`) is represented by a
 * placeholder of the right shape — the point of the exercise is whether the
 * *name* is promised, not whether this file knows the secret.
 */
function environmentOf(serviceName: string): NodeJS.ProcessEnv {
  const service = blueprint.services.find((s) => s.name === serviceName);
  if (!service) throw new Error(`no service named ${serviceName} in the blueprint`);

  const out: NodeJS.ProcessEnv = {};
  const apply = (vars: RenderEnvVar[] | undefined) => {
    for (const entry of vars ?? []) {
      if (entry.fromGroup) {
        const group = blueprint.envVarGroups?.find((g) => g.name === entry.fromGroup);
        if (!group) throw new Error(`no env group named ${entry.fromGroup}`);
        apply(group.envVars);
        continue;
      }
      if (!entry.key) continue;
      out[entry.key] = entry.value !== undefined ? String(entry.value) : placeholderFor(entry.key);
    }
  };
  apply(service.envVars);
  return out;
}

/** A value of the right shape for a secret the dashboard holds. */
function placeholderFor(key: string): string {
  if (key === 'DATABASE_URL') {
    return 'postgresql://ess_app:pw@dpg-internal:5432/widedrop_ess?sslmode=require';
  }
  if (key === 'REDIS_URL') return 'redis://red-internal:6379';
  if (key === 'S3_ENDPOINT') return 'https://s3.example-store.net';
  if (key.endsWith('_URL')) return 'https://placeholder.widedrop.com';
  if (key === 'ENCRYPTION_KEK') return Buffer.alloc(32, 7).toString('base64');
  if (key === 'AUDIT_HMAC_KEY') return Buffer.alloc(32, 9).toString('base64');
  if (key === 'PASSWORD_PEPPER') return 'qW3eR7tY1uI9oP2aS5dF8gH4jK6lZ0xC';
  if (key.startsWith('SMTP_') || key.startsWith('S3_') || key.startsWith('JWT_')) {
    return `placeholder-${key.toLowerCase()}`;
  }
  return 'placeholder';
}

describe('the Render blueprint', () => {
  for (const service of ['ess-api', 'ess-worker']) {
    it(`gives ${service} an environment the validator accepts in production`, () => {
      // The worker calls the same loadEnv() the API does, so both have to
      // satisfy the same rules — including the ones that only look like the
      // API's business, such as CORS_ORIGINS.
      expect(() => loadEnv(environmentOf(service))).not.toThrow();
    });
  }

  it('sets nothing the validator does not read', () => {
    // A variable nobody reads is either a leftover or a typo for one that is
    // required, and the second is the dangerous case.
    //
    // ENV_KEYS rather than the parsed result, which omits any optional the
    // environment did not happen to set.
    const known = new Set<string>(ENV_KEYS);
    // Not part of the schema, but genuinely consumed by the platform.
    const platformOwned = new Set(['PORT', 'HOST']);

    for (const key of Object.keys(environmentOf('ess-api'))) {
      if (platformOwned.has(key)) continue;
      expect(known.has(key), `${key} is set in render.yaml but nothing reads it`).toBe(true);
    }
  });

  it('never puts a secret in the file', () => {
    for (const group of blueprint.envVarGroups ?? []) {
      for (const entry of group.envVars) {
        const secretish = /KEY|PEPPER|PASSWORD|SECRET|DATABASE_URL|REDIS_URL|TOKEN/.test(
          entry.key ?? '',
        );
        // ENCRYPTION_KEY_VERSION is a label, not a key.
        if (!secretish || entry.key === 'ENCRYPTION_KEY_VERSION') continue;
        expect(entry.value, `${entry.key} must be set in the dashboard, not here`).toBeUndefined();
        expect(entry.sync, `${entry.key} must be marked sync: false`).toBe(false);
      }
    }
  });

  it('ships the worker from the same image as the API', () => {
    const api = blueprint.services.find((s) => s.name === 'ess-api');
    const worker = blueprint.services.find((s) => s.name === 'ess-worker');

    // A worker a release behind the API writes rows the API refuses.
    expect(worker?.dockerfilePath).toBe(api?.dockerfilePath);
    expect(worker?.dockerContext).toBe(api?.dockerContext);
    expect(worker?.dockerCommand).toBe('node dist/worker.js');
  });
});

describe('.env.example', () => {
  const example = read('.env.example');
  const documented = new Set(
    example
      .split('\n')
      .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1])
      .filter((key): key is string => Boolean(key)),
  );

  it('documents every variable the API reads', () => {
    // The file is the reference a developer copies and the one a deployment is
    // checked against. A variable missing from it is a variable nobody knows
    // to set.
    for (const key of ENV_KEYS) {
      expect(documented.has(key), `${key} is read by the API but absent from .env.example`).toBe(
        true,
      );
    }
  });

  it('documents nothing the API does not read', () => {
    const known = new Set<string>(ENV_KEYS);

    // The seed scripts are development tooling, not the server: they read
    // these straight from process.env and never reach the validator, which is
    // why they are not in the schema. They are still documented, because a
    // developer running the seed has to know they exist.
    const seedOnly = new Set([
      'SEED_ORG_DOMAIN',
      'SEED_ORG_NAME',
      'SEED_ORG_LEGAL_NAME',
      'SEED_EMPLOYEE_PREFIX',
      'SEED_FY_START',
    ]);

    for (const key of documented) {
      if (seedOnly.has(key)) continue;
      expect(known.has(key), `${key} is in .env.example but nothing reads it`).toBe(true);
    }

    // And the exemption is not a licence: every name on it must genuinely be
    // read somewhere, so a stale one is noticed.
    for (const key of seedOnly) {
      expect(documented.has(key), `${key} is exempted but not documented`).toBe(true);
    }
  });

  it('carries no filled-in secret', () => {
    for (const line of example.split('\n')) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (!match) continue;
      const [, key, value] = match;
      if (!/KEY|PEPPER|PASSWORD|SECRET/.test(key)) continue;
      // ENCRYPTION_KEY_VERSION and JWT_KEY_ID are labels, not secrets.
      if (key === 'ENCRYPTION_KEY_VERSION' || key === 'JWT_KEY_ID') continue;
      expect(value, `${key} must be left blank in .env.example`).toBe('');
    }
  });
});
