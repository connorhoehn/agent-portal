// One timing-safe compare, not three.
//
// `routes/harness.ts` (requireTraceAuth) and `routes/assessment.ts`
// (requireRunCompleteAuth) each carried a private, byte-identical copy of the
// compare in `lib/service-auth.ts`. All three were correct — which is the
// argument for folding them rather than an argument for leaving them: a
// security primitive written three times is one primitive with three chances
// to drift, and only the shared copy had tests.
//
// These tests pin both halves of the fold:
//
//   1. BEHAVIOUR — the full unset/set × no-header / correct / wrong matrix, per
//      spec, so "open when the secret is unset, required when it is set" is
//      asserted for the harness and assessment callbacks and not merely
//      inherited by assumption.
//   2. NO REGROWTH — the two route modules must not reintroduce a local
//      compare. A behaviour test cannot see a fourth copy appearing beside the
//      shared one; reading the source can.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import {
  APPROVALS_SERVICE_AUTH,
  HARNESS_TRACE_SERVICE_AUTH,
  ASSESSMENT_RUN_COMPLETE_SERVICE_AUTH,
  LEGACY_HEADERS_ENV,
  requireServiceAuth,
  type ServiceAuthSpec,
} from '../service-auth.js';

const SPECS: Array<[string, ServiceAuthSpec]> = [
  ['approvals', APPROVALS_SERVICE_AUTH],
  ['harness trace', HARNESS_TRACE_SERVICE_AUTH],
  ['assessment run complete', ASSESSMENT_RUN_COMPLETE_SERVICE_AUTH],
];

function appFor(spec: ServiceAuthSpec) {
  const app = express();
  app.post('/callback', requireServiceAuth(spec), (_req, res) => { res.json({ ok: true }); });
  return app;
}

afterEach(() => { for (const [, s] of SPECS) delete process.env[s.envVar]; });

describe('the machine-callback specs are the canonical list', () => {
  it('names the env var and header each deployed caller actually sends', () => {
    // These four strings are a deploy-time contract with
    // infra/lib/middleware-service-stack.ts (which mints the secrets) and with
    // agents/_shared/callbacks.py (which sends the headers). Renaming one here
    // silently 401s the fleet, so they are spelled out rather than derived.
    // The `signed` audiences are the same kind of contract (lane C4): they
    // must match the `audience=` fields on the Callback specs in callbacks.py.
    expect(APPROVALS_SERVICE_AUTH).toEqual({
      envVar: 'APPROVALS_REQUEST_SECRET', header: 'x-approvals-auth',
      signed: { audience: 'orgiq-middleware/approvals', allowedServices: ['orgiq-agent'] },
    });
    expect(HARNESS_TRACE_SERVICE_AUTH).toEqual({
      envVar: 'HARNESS_TRACE_SECRET', header: 'x-harness-auth',
      signed: { audience: 'orgiq-middleware/harness-trace', allowedServices: ['orgiq-agent'] },
    });
    expect(ASSESSMENT_RUN_COMPLETE_SERVICE_AUTH).toEqual({
      envVar: 'ASSESSMENT_RUN_COMPLETE_SECRET', header: 'x-assessment-run-auth',
      signed: { audience: 'orgiq-middleware/assessment-run-complete', allowedServices: ['orgiq-agent'] },
    });
  });

  it('gives every spec its own env var and its own header', () => {
    const envVars = SPECS.map(([, s]) => s.envVar);
    const headers = SPECS.map(([, s]) => s.header);
    expect(new Set(envVars).size).toBe(envVars.length);
    expect(new Set(headers).size).toBe(headers.length);
  });
});

describe.each(SPECS)('%s — the guard matrix', (_name, spec) => {
  // The static-header compare is the subject here, so the transition flag says
  // `accept`; unset refuses the header (service-envelope-contract.test.ts).
  beforeEach(() => { process.env[LEGACY_HEADERS_ENV] = 'accept'; });
  afterEach(() => { delete process.env[LEGACY_HEADERS_ENV]; process.env['INSECURE_DEV_MODE'] = 'true'; });

  it('UNSET: open to every caller under INSECURE_DEV_MODE, header or not; 503 without the flag', async () => {
    const app = appFor(spec);
    expect((await request(app).post('/callback')).status).toBe(200);
    expect((await request(app).post('/callback').set(spec.header, 'anything')).status).toBe(200);
    delete process.env['INSECURE_DEV_MODE'];
    expect((await request(app).post('/callback')).status).toBe(503);
    expect((await request(app).post('/callback').set(spec.header, 'anything')).status).toBe(503);
  });

  it('SET: no header 401s, the exact value passes, a wrong value 401s', async () => {
    process.env[spec.envVar] = 'shared-secret-value';
    const app = appFor(spec);
    expect((await request(app).post('/callback')).status).toBe(401);
    expect((await request(app).post('/callback').set(spec.header, 'shared-secret-value')).status).toBe(200);
    expect((await request(app).post('/callback').set(spec.header, 'wrong')).status).toBe(401);
    // A prefix of the secret must not pass — the length check is part of the
    // compare, not an optimisation around timingSafeEqual's throw.
    expect((await request(app).post('/callback').set(spec.header, 'shared-secret-valu')).status).toBe(401);
  });

  it('SET: another callback\'s header does not open this one', async () => {
    process.env[spec.envVar] = 'shared-secret-value';
    const others = SPECS.filter(([, s]) => s.header !== spec.header);
    const app = appFor(spec);
    for (const [, other] of others) {
      expect((await request(app).post('/callback').set(other.header, 'shared-secret-value')).status).toBe(401);
    }
  });

  it('SET with a pasted trailing newline: the trimmed value still matches', async () => {
    // `aws secretsmanager get-secret-value --output text` hands back a trailing
    // newline. Before the fold, harness/assessment compared it untrimmed and
    // 401'd every correct caller; the shared guard trims, and the agent half
    // (agents/_shared/callbacks.py) trims for the same reason.
    process.env[spec.envVar] = 'shared-secret-value\n';
    const app = appFor(spec);
    expect((await request(app).post('/callback').set(spec.header, 'shared-secret-value')).status).toBe(200);
    // Trimming widens what counts as the same secret; it does not open the gate.
    expect((await request(app).post('/callback')).status).toBe(401);
  });
});

describe('the private copies do not grow back', () => {
  it('no route file anywhere implements the compare itself', () => {
    // The whole point of the consolidation: one timing-safe comparison in the
    // tree, so a fix or a flaw lands in exactly one place. A new machine
    // callback adds a ServiceAuthSpec, never another compare.
    const dir = join(process.cwd(), 'src', 'routes');
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /timingSafeEqual/.test(readFileSync(join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  const read = (rel: string): string => readFileSync(join(process.cwd(), 'src', 'routes', rel), 'utf8');

  it.each(['harness.ts', 'assessment.ts', 'lab.ts', 'mock-control.ts'])('%s holds no compare of its own', (file) => {
    const src = read(file);
    expect(src).not.toMatch(/timingSafeEqual/);
    expect(src).toContain("from '../lib/service-auth.js'");
  });

  it('still applies the guard PER ROUTE, never at the mount', () => {
    // The failure this pins is the one CLAUDE.md's auth-floor gotcha describes:
    // a blanket guard over one of these routers silently 401s the deployed
    // fleet's trace emission / run callbacks. The guard must appear as an
    // argument to the specific route registration.
    expect(read('harness.ts')).toMatch(/harnessRouter\.post\('\/trace', requireTraceAuth,/);
    expect(read('assessment.ts'))
      .toMatch(/assessmentRouter\.post\('\/runs\/:runId\/complete', requireRunCompleteAuth,/);
    // And neither router may pass a service guard to `.use(...)`.
    for (const file of ['harness.ts', 'assessment.ts']) {
      expect(read(file)).not.toMatch(/Router\.use\(require(Trace|RunComplete|Service)Auth/);
    }
  });
});
