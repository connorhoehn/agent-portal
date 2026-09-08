// GET /api/observability/approvals/:id — the HITL long-poll, which has TWO
// kinds of caller.
//
// The bug this pins: the route was session + Cedar gated only, but the caller
// that has to read it in order to close the loop is a deployed agent runtime
// with no cookie. Against a session-enforcing deployment (Cognito configured,
// so the demo fallback is off) every poll 401'd — the human approved in the
// portal and the agent reported EXPIRED five minutes later.
//
// The fix is `serviceAuthOr`, NOT the open-when-unset shape the write callbacks
// use. So the two things asserted hardest here are:
//   1. With APPROVALS_REQUEST_SECRET unset, this route is byte-for-byte what it
//      was: anonymous 401s, a session reads. Nothing was opened.
//   2. With it set, the fleet credential passes AND the human gate still works
//      for humans — and the neighbouring human surfaces (GET /, GET /stream)
//      never accept the credential.
//
// Cognito is configured in the mocked config on purpose: that is what turns off
// the permissive demo-user fallback and makes this a real session-enforcing
// deployment rather than a dev box where everything answers 200.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    // No cluster ARN → approvals.ts uses its in-memory mock store.
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    mock: { aurora: true },
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
      capabilities: ['ViewObservability', 'ApproveTransaction'] },
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '',
      capabilities: ['ViewObservability'] },
  ],
}));

jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { approvalsRouter } from '../approvals.js';
import { errorHandler } from '../../lib/async-handler.js';

const SECRET = 'fleet-secret-value';
const HEADER = 'x-approvals-auth';

type FakeSession = { sub: string; name: string; role: string; tenant: string; grants: Record<string, string[]>; iat: number };

function sessionFor(role: string, tenant: string): FakeSession {
  return { sub: `u-${role}`, name: role, role, tenant, grants: { [tenant]: [role] }, iat: 0 };
}

/** `session` null = an anonymous request, exactly like a deployed agent's. */
function buildApp(session: FakeSession | null) {
  const app = express();
  app.use(express.json());
  if (session) {
    app.use((req, _res, next) => {
      (req as unknown as { session: FakeSession }).session = session;
      next();
    });
  }
  app.use('/api/observability/approvals', approvalsRouter);
  app.use(errorHandler);
  return app;
}

/** File an approval the way the agent does, returning its id. */
async function fileApproval(app: express.Express, extraHeaders: Record<string, string> = {}): Promise<string> {
  const req = request(app).post('/api/observability/approvals/request');
  for (const [k, v] of Object.entries(extraHeaders)) req.set(k, v);
  const res = await req.send({ txId: 'tx-1', agentId: 'orgiq-supervisor', payload: { amount: 25000 }, reason: 'over threshold' });
  expect(res.status).toBe(201);
  return res.body.approvalId as string;
}

const ORIGINAL = process.env['APPROVALS_REQUEST_SECRET'];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['APPROVALS_REQUEST_SECRET'];
  else process.env['APPROVALS_REQUEST_SECRET'] = ORIGINAL;
});

describe('secret UNSET — the route is unchanged', () => {
  beforeEach(() => { delete process.env['APPROVALS_REQUEST_SECRET']; });

  it('401s a sessionless poll, with or without a header', async () => {
    const human = buildApp(sessionFor('org-leader', 'orgiq'));
    const id = await fileApproval(human);

    const anon = buildApp(null);
    expect((await request(anon).get(`/api/observability/approvals/${id}`)).status).toBe(401);
    // No secret configured means no credential exists — a header is just bytes.
    expect((await request(anon).get(`/api/observability/approvals/${id}`).set(HEADER, 'anything')).status).toBe(401);
  });

  it('a session that holds ViewObservability in orgiq still reads the row', async () => {
    const human = buildApp(sessionFor('org-leader', 'orgiq'));
    const id = await fileApproval(human);
    const res = await request(human).get(`/api/observability/approvals/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approvalId: id, status: 'PENDING' });
  });
});

describe('secret SET — the fleet can poll, humans are unaffected', () => {
  beforeEach(() => { process.env['APPROVALS_REQUEST_SECRET'] = SECRET; });

  it('a sessionless poll carrying the credential reads the row', async () => {
    const human = buildApp(sessionFor('org-leader', 'orgiq'));
    const id = await fileApproval(human, { [HEADER]: SECRET });

    const res = await request(buildApp(null))
      .get(`/api/observability/approvals/${id}`)
      .set(HEADER, SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approvalId: id, status: 'PENDING' });
  });

  it('a sessionless poll with no / a wrong credential is still 401', async () => {
    const human = buildApp(sessionFor('org-leader', 'orgiq'));
    const id = await fileApproval(human, { [HEADER]: SECRET });
    const anon = buildApp(null);
    expect((await request(anon).get(`/api/observability/approvals/${id}`)).status).toBe(401);
    expect((await request(anon).get(`/api/observability/approvals/${id}`).set(HEADER, 'wrong')).status).toBe(401);
  });

  it('the human gate is still enforced for sessions — wrong tenant is 403, not bypassed', async () => {
    const human = buildApp(sessionFor('org-leader', 'orgiq'));
    const id = await fileApproval(human, { [HEADER]: SECRET });
    const outOfTenant = buildApp(sessionFor('assessor', 'assessment'));
    const res = await request(outOfTenant).get(`/api/observability/approvals/${id}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ requiredTenant: 'orgiq' });
  });

  it('the credential does NOT open the human queue or the SSE feed', async () => {
    const anon = buildApp(null);
    expect((await request(anon).get('/api/observability/approvals').set(HEADER, SECRET)).status).toBe(401);
    expect((await request(anon).get('/api/observability/approvals/stream').set(HEADER, SECRET)).status).toBe(401);
  });

  it('the credential does NOT let a machine DECIDE an approval', async () => {
    const human = buildApp(sessionFor('org-leader', 'orgiq'));
    const id = await fileApproval(human, { [HEADER]: SECRET });
    const res = await request(buildApp(null))
      .post(`/api/observability/approvals/${id}/decision`)
      .set(HEADER, SECRET)
      .send({ decision: 'APPROVED' });
    expect(res.status).toBe(401);
  });

  it('POST /request keeps its open-when-configured-only contract', async () => {
    const anon = buildApp(null);
    const bare = await request(anon)
      .post('/api/observability/approvals/request')
      .send({ txId: 'tx-2', agentId: 'a', payload: {}, reason: 'r' });
    expect(bare.status).toBe(401);
    const authed = await request(anon)
      .post('/api/observability/approvals/request')
      .set(HEADER, SECRET)
      .send({ txId: 'tx-2', agentId: 'a', payload: {}, reason: 'r' });
    expect(authed.status).toBe(201);
  });
});

describe('the whole HITL loop closes for a sessionless agent', () => {
  it('agent files → human decides → agent polls and sees the decision', async () => {
    process.env['APPROVALS_REQUEST_SECRET'] = SECRET;
    const agent = buildApp(null);
    const human = buildApp(sessionFor('org-leader', 'orgiq'));

    const id = await fileApproval(agent, { [HEADER]: SECRET });

    const decided = await request(human)
      .post(`/api/observability/approvals/${id}/decision`)
      .send({ decision: 'APPROVED', note: 'ok by me' });
    expect(decided.status).toBe(200);

    const poll = await request(agent).get(`/api/observability/approvals/${id}`).set(HEADER, SECRET);
    expect(poll.status).toBe(200);
    expect(poll.body).toMatchObject({ status: 'APPROVED', decidedNote: 'ok by me' });
  });
});
