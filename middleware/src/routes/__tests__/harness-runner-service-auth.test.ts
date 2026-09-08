// The harness RUNNER's identity — `infra/scripts/harness.py` against a
// session-enforcing deployment.
//
// The bug this pins: an earlier slice gave the runner a credential for exactly
// one route (`POST /harness/trace`) and left the rest of its control plane —
// prompt-versions, runs, results, the final PATCH — session-gated with no
// cookie and no credential. Those worked only through the dev demo-user
// fallback, which `demoFallbackAllowed()` turns off the moment Cognito is
// configured. So the runner passed locally and 401'd wholesale in the
// environment it was built for, and did so ASYMMETRICALLY: the trace POST
// succeeded while the result POST recording the verdict did not.
//
// The fix is `serviceAuthOr`, never the open-when-unset shape. What is asserted
// hardest, therefore:
//   1. With HARNESS_RUNNER_SECRET unset, every one of these routes is
//      byte-for-byte what it was — anonymous 401s even holding a header, a
//      session reads. Nothing was opened.
//   2. With it set, the runner passes AND the human gates still apply to
//      humans (wrong tenant is still 403).
//   3. The credential is SCOPED: it does not open case authoring, and it is not
//      the trace secret wearing a different hat.
//
// Cognito is configured in the mocked config on purpose — that is what turns
// off the permissive demo-user fallback and makes this a real session-enforcing
// deployment rather than a dev box where everything answers 200.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    aurora: { clusterArn: 'arn:cluster', secretArn: 'arn:secret', database: 'orgiq' },
    mock: { aurora: false },
    auth: { policyStoreId: undefined },
    cognito: {
      userPoolId: 'us-east-1_test', clientId: 'cid', clientSecret: 'csec',
      domain: 'example.auth', callbackUrl: 'http://localhost/cb',
    },
  },
}));

// Open-mode authz reads the Cedar seeds through role-registry, which uses
// import.meta.url and cannot load under ts-jest's CJS transform.
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'org-leader', tenant: 'orgiq', label: 'Org Leader', summary: '',
      capabilities: ['ViewObservability', 'ManageCanary'] },
    { id: 'member', tenant: 'orgiq', label: 'Member', summary: '',
      capabilities: ['ViewObservability'] },
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '',
      capabilities: ['ViewObservability', 'ManageCanary'] },
  ],
}));

jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

// The Data API is not the subject here — the gate in front of it is. Every
// handler under test gets an empty result set, which is a well-formed answer
// for each of them (a create returns its own uuid, a list returns no rows, a
// promote 404s a version it cannot find). A 401/403 therefore means the GATE
// spoke, and anything else means the request reached the handler.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn(async () => []) }));
jest.mock('../../lib/trace-sink.js', () => ({ processTrace: jest.fn() }));
jest.mock('../../lib/judge.js', () => ({ judgeResponse: jest.fn() }));
jest.mock('../../lib/harness-runner.js', () => ({
  executeRun: jest.fn(), loadCasesForRun: jest.fn(async () => []),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { harnessRouter } from '../harness.js';
import { promptVersionsRouter } from '../prompt-versions.js';
import { errorHandler } from '../../lib/async-handler.js';
import { HARNESS_RUNNER_SERVICE_AUTH, serviceAuthOr } from '../../lib/service-auth.js';
import { requireAction, requireTenant } from '../../lib/authz.js';

const SECRET = 'runner-secret-value';
const HEADER = 'x-harness-runner-auth';

type FakeSession = {
  sub: string; name: string; role: string; tenant: string;
  grants: Record<string, string[]>; iat: number;
};

function sessionFor(role: string, tenant: string): FakeSession {
  return { sub: `u-${role}`, name: role, role, tenant, grants: { [tenant]: [role] }, iat: 0 };
}

/** `session` null = a request exactly like the runner's: no cookie at all. */
function buildApp(session: FakeSession | null) {
  const app = express();
  app.use(express.json());
  if (session) {
    app.use((req, _res, next) => {
      (req as unknown as { session: FakeSession }).session = session;
      next();
    });
  }
  app.use('/api/observability/harness', harnessRouter);
  // index.ts mounts this router behind `viewObs` with the same serviceAuthOr
  // wrapper; reproduce that here, because a mount guard runs BEFORE the route's
  // own and a fix applied to only one of the two would 401 the runner anyway.
  app.use(
    '/api/observability/prompt-versions',
    serviceAuthOr(
      HARNESS_RUNNER_SERVICE_AUTH,
      requireTenant('orgiq'),
      requireAction('ViewObservability'),
    ),
    promptVersionsRouter,
  );
  app.use(errorHandler);
  return app;
}

const ORIGINAL = process.env['HARNESS_RUNNER_SECRET'];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['HARNESS_RUNNER_SECRET'];
  else process.env['HARNESS_RUNNER_SECRET'] = ORIGINAL;
});

/** Every call `infra/scripts/harness.py` makes that is not the trace POST. */
const RUNNER_CALLS: Array<{ what: string; send: (app: express.Express) => Promise<{ status: number }> }> = [
  {
    what: 'POST /prompt-versions (run start — stamps provenance)',
    send: (app) => request(app).post('/api/observability/prompt-versions')
      .send({ agentId: 'orgiq-search', content: 'you are a search agent' }),
  },
  {
    what: 'POST /harness/runs (create the run row)',
    send: (app) => request(app).post('/api/observability/harness/runs')
      .send({ label: 'nightly', totalCases: 3, mode: 'live' }),
  },
  {
    what: 'POST /harness/runs/:id/results (record one verdict)',
    send: (app) => request(app).post('/api/observability/harness/runs/r1/results')
      .send({ testId: 'search.expert.k8s.001', passed: true }),
  },
  {
    what: 'PATCH /harness/runs/:id (finalise the run)',
    send: (app) => request(app).patch('/api/observability/harness/runs/r1')
      .send({ status: 'done', passRate: 1 }),
  },
  {
    what: 'GET /harness/runs (find the prior run to diff against)',
    send: (app) => request(app).get('/api/observability/harness/runs?limit=5'),
  },
  {
    what: 'GET /harness/runs/:id (status + diff)',
    send: (app) => request(app).get('/api/observability/harness/runs/r1'),
  },
  {
    what: 'POST /harness/promote (promote a prompt version)',
    send: (app) => request(app).post('/api/observability/harness/promote')
      .send({ promptVersion: 'abc123', agentId: 'orgiq-search' }),
  },
];

describe('secret UNSET — nothing is opened', () => {
  beforeEach(() => { delete process.env['HARNESS_RUNNER_SECRET']; });

  it.each(RUNNER_CALLS)('401s a cookie-less $what', async ({ send }) => {
    expect((await send(buildApp(null))).status).toBe(401);
  });

  it.each(RUNNER_CALLS)('401s $what even WITH a header — no secret means no credential', async ({ send }) => {
    // `hasServiceAuth` is false when unconfigured on purpose: "no credential
    // exists" is a different question from "is this route open".
    const app = buildApp(null);
    const res = await (send(app) as unknown as { set: (k: string, v: string) => Promise<{ status: number }> })
      .set(HEADER, 'anything');
    expect(res.status).toBe(401);
  });

  it('a human with ManageCanary in orgiq is unaffected', async () => {
    const res = await request(buildApp(sessionFor('org-leader', 'orgiq')))
      .post('/api/observability/harness/runs').send({ label: 'by hand' });
    expect(res.status).toBe(201);
  });
});

describe('secret SET — the runner has an identity', () => {
  beforeEach(() => { process.env['HARNESS_RUNNER_SECRET'] = SECRET; });

  it.each(RUNNER_CALLS)('lets the runner through on $what', async ({ send }) => {
    const app = buildApp(null);
    const res = await (send(app) as unknown as { set: (k: string, v: string) => Promise<{ status: number }> })
      .set(HEADER, SECRET);
    // Not 401 and not 403: the gate is satisfied and the handler answered.
    // (Which 2xx/404 it answers is that handler's own contract, tested
    // elsewhere — what this suite owns is that the runner is not turned away.)
    expect([401, 403]).not.toContain(res.status);
    expect(res.status).toBeLessThan(500);
  });

  it.each(RUNNER_CALLS)('still 401s $what with a WRONG credential', async ({ send }) => {
    const app = buildApp(null);
    const res = await (send(app) as unknown as { set: (k: string, v: string) => Promise<{ status: number }> })
      .set(HEADER, 'wrong-value');
    expect(res.status).toBe(401);
  });

  it('does not accept the TRACE secret in place of the runner secret', async () => {
    // Two credentials, two scopes. The trace secret is deployed to nine agent
    // runtimes; it must not also write the harness control plane.
    process.env['HARNESS_TRACE_SECRET'] = 'trace-secret';
    const res = await request(buildApp(null))
      .post('/api/observability/harness/runs')
      .set('x-harness-auth', 'trace-secret')
      .send({ label: 'nope' });
    delete process.env['HARNESS_TRACE_SECRET'];
    expect(res.status).toBe(401);
  });

  it('keeps the human gates for humans — a wrong-tenant session is still 403', async () => {
    const res = await request(buildApp(sessionFor('assessor', 'assessment')))
      .post('/api/observability/harness/runs').send({ label: 'cross-tenant' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ requiredTenant: 'orgiq' });
  });

  it('keeps the Cedar gate for humans — a member without ManageCanary is still 403', async () => {
    const res = await request(buildApp(sessionFor('member', 'orgiq')))
      .post('/api/observability/harness/runs').send({ label: 'no authority' });
    expect(res.status).toBe(403);
  });

  it('is SCOPED — it does not open test-case authoring', async () => {
    // The runner reads cases straight from Aurora over the Data API and never
    // edits them, so writing a case stays a human decision.
    const app = buildApp(null);
    for (const send of [
      () => request(app).post('/api/observability/harness/cases')
        .set(HEADER, SECRET).send({ agentId: 'orgiq-search', prompt: 'p' }),
      () => request(app).patch('/api/observability/harness/cases/c1')
        .set(HEADER, SECRET).send({ active: false }),
      () => request(app).delete('/api/observability/harness/cases/c1').set(HEADER, SECRET),
    ]) {
      expect((await send()).status).toBe(401);
    }
  });
});
