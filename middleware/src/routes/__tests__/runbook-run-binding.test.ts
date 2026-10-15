// A box acts only for its own run (lane E, the R3 security finding): the fleet's
// shared LAB_CALLBACK_SECRET proves "some box"; the per-run token minted at
// dispatch/claim (lib/run-token.ts, keyed by the SESSION signing key, which no
// box holds) proves "the box running THIS run". Every route that acts on a run
// requires both. And whoever dispatched a run cannot accept what its box proposed.

jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../providers/identity.js', () => ({
  getUser: jest.fn(async (sub: string) => {
    const { personOf } = jest.requireActual('./runbook-world');
    return { personId: personOf(sub) };
  }),
}));
jest.mock('../../providers/projects.js', () => ({
  getProject: jest.fn(async (id: string) => jest.requireActual('./runbook-world').PROJECTS[id] ?? null),
}));
jest.mock('../../providers/work-items.js', () => ({
  getWorkItem: jest.fn(async (id: string) => (id === 'wi-auth-1' ? { id, projectId: 'p-auth' } : null)),
  getProjectDecisions: jest.fn(async () => []),
}));

import express from 'express';
import { createHmac, randomBytes } from 'node:crypto';
import request from '../../test-support/http.js';
import { SERVICE_AUTH_HEADER, signServiceRequest } from '@connorhoehn/service-runtime';
import { LAB_CALLBACK_SERVICE_AUTH, SERVICE_NONCE_HEADER, captureRawBody, resetServiceNonceCache } from '../../lib/service-auth.js';
import { RUN_TOKEN_HEADER, mintRunToken, verifyRunToken } from '../../lib/run-token.js';
import { createRunbooksRouter } from '../runbooks.js';
import { createSessionBriefsRouter } from '../session-briefs.js';
import { errorHandler } from '../../lib/async-handler.js';
import { assembleBrief, selectRunbooks, type RunbookStore } from '../../lib/runbooks/index.js';
import { loadCandidates } from '../../lib/session-brief-preview.js';
import { EDIT_MD, USERS, seededStore, type TestUser } from './runbook-world.js';

const SECRET = 'lab-secret';
let store: RunbookStore;

function appAs(user: TestUser | null) {
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.use((req, _res, next) => {
    if (user) (req as unknown as { session: unknown }).session = { sub: user.sub, role: user.role, tenant: user.tenant, grants: { [user.tenant]: [user.role] }, iat: 0 };
    else (req as unknown as { sessionInvalid: boolean }).sessionInvalid = true;
    next();
  });
  app.use('/api/runbooks', createRunbooksRouter({ store: () => store }));
  app.use('/api', createSessionBriefsRouter({ store: () => store }));
  app.use(errorHandler);
  return app;
}

function box(method: string, target: string, body = '', runToken?: string): Record<string, string> {
  const nonce = randomBytes(18).toString('base64url');
  return {
    [SERVICE_AUTH_HEADER]: signServiceRequest({ method, target, body }, { secret: SECRET, serviceId: 'orgiq-devbox', audience: `orgiq-middleware/lab#${nonce}` }),
    [SERVICE_NONCE_HEADER]: nonce,
    'content-type': 'application/json',
    ...(runToken ? { [RUN_TOKEN_HEADER]: runToken } : {}),
  };
}

/** Freeze a brief for `runRef` that gives rb-tenant-cutover, dispatched by `by`. */
async function freeze(runRef: string, by: string | null = null) {
  const candidates = await loadCandidates(store, Date.parse('2026-10-14T00:00:00Z'));
  const selected = selectRunbooks({ id: 'wi-auth-1', title: 'Cut one tenant over from SAML to Cognito', description: 'tenant cutover saml cognito', labels: ['cutover'], repo: null, initiative_id: 'p-auth', pinned_runbook_ids: ['rb-tenant-cutover'] }, candidates).selected;
  const brief = { ...assembleBrief({ run_ref: runRef, assembled_at: '2026-10-14T00:00:00.000Z', framing: '', work_item: null, initiative: null, decisions: [], runbooks: selected }), dispatched_by: by };
  await store.putBrief(brief);
  return brief;
}

beforeEach(() => {
  store = seededStore();
  process.env[LAB_CALLBACK_SERVICE_AUTH.envVar] = SECRET;
  resetServiceNonceCache();
});
afterEach(() => { delete process.env[LAB_CALLBACK_SERVICE_AUTH.envVar]; });

describe('the run token', () => {
  it('verifies for its own run only, and cannot be forged from the fleet secret', async () => {
    const t = await mintRunToken('job-a');
    expect(await verifyRunToken(t, 'job-a')).toBe(true);
    expect(await verifyRunToken(t, 'job-b')).toBe(false);
    // What a box COULD compute: an HMAC of the run ref under the secret it holds.
    const forged = createHmac('sha256', SECRET).update('job-b').digest('base64url');
    expect(await verifyRunToken(forged, 'job-b')).toBe(false);
    expect(await verifyRunToken(`${Buffer.from(JSON.stringify({ k: 'lab-run', v: 1, r: 'job-b' })).toString('base64url')}.${forged}`, 'job-b')).toBe(false);
  });
});

describe('GET /api/runs/:ref/brief — box A cannot read box B', () => {
  it('needs the envelope AND the token for exactly this run', async () => {
    const a = await freeze('job-a');
    await freeze('job-b');
    const anon = appAs(null);
    const tokenA = await mintRunToken('job-a');
    const path = (ref: string) => `/api/runs/${ref}/brief?format=markdown`;

    const own = await request(anon).get(path('job-a')).set(box('GET', path('job-a'), '', tokenA));
    expect(own.status).toBe(200);
    expect(own.text).toBe(a.markdown);

    // The old shared-secret-only envelope is refused.
    expect((await request(anon).get(path('job-a')).set(box('GET', path('job-a')))).body.code).toBe('RUN_TOKEN');
    // A's token on B's run: refused, and the same answer whether or not B exists.
    const crossB = await request(anon).get(path('job-b')).set(box('GET', path('job-b'), '', tokenA));
    const crossNone = await request(anon).get(path('job-zzz')).set(box('GET', path('job-zzz'), '', tokenA));
    expect([crossB.status, crossB.body.code]).toEqual([403, 'RUN_TOKEN']);
    expect([crossNone.status, crossNone.body.code]).toEqual([403, 'RUN_TOKEN']);
    // A token without the envelope is not a credential on its own.
    expect((await request(anon).get(path('job-a')).set(RUN_TOKEN_HEADER, tokenA)).status).toBe(401);
  });
});

describe('GET /api/runs/:ref/runbooks/:id — `lab runbook`', () => {
  it('serves a runbook the brief named, to that run only', async () => {
    await freeze('job-a');
    const anon = appAs(null);
    const tokenA = await mintRunToken('job-a');
    const p = '/api/runs/job-a/runbooks/rb-tenant-cutover';
    const ok = await request(anon).get(p).set(box('GET', p, '', tokenA));
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('# Cut one tenant over');
    const notNamed = '/api/runs/job-a/runbooks/rb-sso-new-origin';
    expect((await request(anon).get(notNamed).set(box('GET', notNamed, '', tokenA))).body.code).toBe('NOT_GIVEN');
    const other = '/api/runs/job-b/runbooks/rb-tenant-cutover';
    expect((await request(anon).get(other).set(box('GET', other, '', tokenA))).body.code).toBe('RUN_TOKEN');
  });
});

describe('a box files proposals and applications for its own run only', () => {
  const proposal = (runRef: string) => JSON.stringify({ kind: 'edit', runbook_id: 'rb-tenant-cutover', markdown: EDIT_MD, rationale: 'The flip needed the callback first.', source: { run_ref: runRef, work_item_id: 'wi-spoofed' } });

  it('proposals: envelope-only refused, another run refused, own run accepted and attributed from the brief', async () => {
    await freeze('job-a', 'u-own');
    await freeze('job-b');
    const anon = appAs(null);
    const tokenA = await mintRunToken('job-a');
    const P = '/api/runbooks/proposals';

    expect((await request(anon).post(P).set(box('POST', P, proposal('job-a'))).send(proposal('job-a'))).body.code).toBe('RUN_TOKEN');
    expect((await request(anon).post(P).set(box('POST', P, proposal('job-b'), tokenA)).send(proposal('job-b'))).body.code).toBe('RUN_TOKEN');
    const ok = await request(anon).post(P).set(box('POST', P, proposal('job-a'), tokenA)).send(proposal('job-a'));
    expect(ok.status).toBe(201);
    // Attribution comes from the frozen brief, never the body.
    expect(ok.body.proposal.source.work_item_id).toBeUndefined();
    expect(ok.body.proposal.source.dispatched_by).toBe('u-own');

    // A run with no frozen brief has no standing to propose.
    const tokenNone = await mintRunToken('job-none');
    expect((await request(anon).post(P).set(box('POST', P, proposal('job-none'), tokenNone)).send(proposal('job-none'))).body.code).toBe('NO_BRIEF');
  });

  it('applications: a leaked token for run X is useless for run Y', async () => {
    await freeze('job-x');
    await freeze('job-y');
    const anon = appAs(null);
    const tokenX = await mintRunToken('job-x');
    const path = '/api/runbooks/rb-tenant-cutover/applications';
    const body = (ref: string) => JSON.stringify({ run_ref: ref, outcome: 'failed', failed_at_step: 2 });

    expect((await request(anon).post(path).set(box('POST', path, body('job-y'), tokenX)).send(body('job-y'))).body.code).toBe('RUN_TOKEN');
    expect((await request(anon).post(path).set(box('POST', path, body('job-y'))).send(body('job-y'))).body.code).toBe('RUN_TOKEN');
    expect((await request(anon).post(path).set(box('POST', path, body('job-x'), tokenX)).send(body('job-x'))).status).toBe(201);
    expect(await store.listApplications('rb-tenant-cutover')).toEqual([expect.objectContaining({ run_ref: 'job-x', brief_id: 'brief-job-x' })]);
  });
});

describe('the dispatcher of a run cannot accept its proposal', () => {
  it('the owner who dispatched is refused; another steward may accept', async () => {
    await freeze('job-a', USERS.owner!.sub);
    const tokenA = await mintRunToken('job-a');
    const P = '/api/runbooks/proposals';
    const body = proposal();
    function proposal() { return JSON.stringify({ kind: 'edit', runbook_id: 'rb-tenant-cutover', markdown: EDIT_MD, rationale: 'The flip needed the callback first.', source: { run_ref: 'job-a' } }); }
    const filed = await request(appAs(null)).post(P).set(box('POST', P, body, tokenA)).send(body);
    expect(filed.status).toBe(201);
    const id = filed.body.proposal.id as string;

    const self = await request(appAs(USERS.owner!)).post(`/api/runbooks/proposals/${id}/accept`).send({});
    expect([self.status, self.body.code]).toEqual([403, 'SELF_ACCEPT']);
    const other = await request(appAs(USERS.smeAuth!)).post(`/api/runbooks/proposals/${id}/accept`).send({});
    expect(other.status).toBe(200);
  });
});
