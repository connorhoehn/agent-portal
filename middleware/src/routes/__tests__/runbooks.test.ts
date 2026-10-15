// /api/runbooks — reads, proposing, and the authz contracts for deciding.
// The REAL authz stack runs (seed Cedar matrix, no policy store), so "a member
// cannot accept" is the actual role matrix, not a stub. Identity and project
// lookups are mocked so each persona's stewardship is explicit.

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
}));

import express from 'express';
import { randomBytes } from 'node:crypto';
import request from '../../test-support/http.js';
import { SERVICE_AUTH_HEADER, signServiceRequest } from '@connorhoehn/service-runtime';
import { LAB_CALLBACK_SERVICE_AUTH, SERVICE_NONCE_HEADER, captureRawBody, resetServiceNonceCache } from '../../lib/service-auth.js';
import { RUN_TOKEN_HEADER, mintRunToken } from '../../lib/run-token.js';
import { createRunbooksRouter } from '../runbooks.js';
import { errorHandler } from '../../lib/async-handler.js';
import { assembleBrief, selectRunbooks, runbookHealth, type RunbookStore } from '../../lib/runbooks/index.js';
import { loadCandidates } from '../../lib/session-brief-preview.js';
import { EDIT_MD, EDIT_MD_ALT, NEW_MD, USERS, seededStore, type TestUser } from './runbook-world.js';

const SECRET = 'lab-secret';
let store: RunbookStore;

function appAs(user: TestUser | null) {
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.use((req, _res, next) => {
    if (user) (req as unknown as { session: unknown }).session = { sub: user.sub, role: user.role, tenant: user.tenant, grants: { [user.tenant]: [user.role] }, iat: 0 };
    else (req as unknown as { sessionInvalid: boolean }).sessionInvalid = true; // anonymous: no demo fallback
    next();
  });
  app.use('/api/runbooks', createRunbooksRouter({ store: () => store }));
  app.use(errorHandler);
  return app;
}

/** Headers for a box's signed lab envelope over exactly this request. */
function boxHeaders(method: string, target: string, body = '', runToken?: string): Record<string, string> {
  const nonce = randomBytes(18).toString('base64url');
  return {
    [SERVICE_AUTH_HEADER]: signServiceRequest({ method, target, body }, { secret: SECRET, serviceId: 'orgiq-devbox', audience: `orgiq-middleware/lab#${nonce}` }),
    [SERVICE_NONCE_HEADER]: nonce,
    'content-type': 'application/json',
    ...(runToken ? { [RUN_TOKEN_HEADER]: runToken } : {}),
  };
}

beforeEach(() => {
  store = seededStore();
  process.env[LAB_CALLBACK_SERVICE_AUTH.envVar] = SECRET;
  resetServiceNonceCache();
});
afterEach(() => { delete process.env[LAB_CALLBACK_SERVICE_AUTH.envVar]; });

/** A person's edit proposal against rb-tenant-cutover; returns its id. */
async function propose(user: TestUser, markdown = EDIT_MD, extra: Record<string, unknown> = {}): Promise<string> {
  const app = appAs(user);
  const res = await request(app).post('/api/runbooks/proposals').send({ kind: 'edit', runbook_id: 'rb-tenant-cutover', markdown, rationale: 'A run found the callback step missing.', ...extra });
  expect(res.status).toBe(201);
  return res.body.proposal.id;
}

describe('reads', () => {
  it('a member lists, reads, and sees versions and a diff; an anonymous caller gets 401', async () => {
    const member = appAs(USERS.member!);
    const list = await request(member).get('/api/runbooks/');
    expect(list.status).toBe(200);
    expect(list.body.runbooks.map((r: { id: string }) => r.id).sort()).toEqual(['rb-flaky-test-rerun-diff', 'rb-sso-new-origin', 'rb-tenant-cutover']);
    expect(list.body.runbooks[0]).toEqual(expect.objectContaining({ title: expect.any(String), health: expect.objectContaining({ status: 'unproven' }), open_proposals: 0 }));

    const one = await request(member).get('/api/runbooks/rb-tenant-cutover');
    expect(one.status).toBe(200);
    expect(one.body.current.markdown).toContain('# Cut one tenant over');
    expect(one.body.can_review).toBe(false);

    const versions = await request(member).get('/api/runbooks/rb-tenant-cutover/versions');
    expect(versions.body.versions).toHaveLength(1);
    expect(versions.body.versions[0].sha256).toMatch(/^[0-9a-f]{64}$/);

    expect((await request(member).get('/api/runbooks/rb-nope')).status).toBe(404);
    expect((await request(appAs(null)).get('/api/runbooks/')).status).toBe(401);
    expect((await request(appAs(USERS.assessor!)).get('/api/runbooks/')).status).toBe(403); // another tenant: requireTenant
    expect((await request(appAs(USERS.strayAssessor!)).post('/api/runbooks/proposals/prop-x/accept').send({})).body.action).toBe('ReviewRunbook');
  });

  it('filters by scope, status, text and health', async () => {
    const member = appAs(USERS.member!);
    const byScope = await request(member).get('/api/runbooks/?scope_kind=initiative&scope_ref=p-auth');
    expect(byScope.body.runbooks.map((r: { id: string }) => r.id)).toEqual(['rb-tenant-cutover']);
    const byText = await request(member).get('/api/runbooks/?q=sso');
    expect(byText.body.runbooks.map((r: { id: string }) => r.id)).toEqual(['rb-sso-new-origin']);
    const drifting = await request(member).get('/api/runbooks/?health=drifting');
    expect(drifting.body.runbooks).toEqual([]);
    expect((await request(member).get('/api/runbooks/?status=bogus')).status).toBe(400);
    expect((await request(member).get('/api/runbooks/?status=retired')).body.runbooks).toEqual([]);
  });

  it('diffs two versions of canonical markdown after an accepted edit', async () => {
    const id = await propose(USERS.proposer!);
    await request(appAs(USERS.owner!)).post(`/api/runbooks/proposals/${id}/accept`).send({}).expect(200);
    const member = appAs(USERS.member!);
    const diff = await request(member).get('/api/runbooks/rb-tenant-cutover/diff?from=1&to=2');
    expect(diff.status).toBe(200);
    expect(diff.body.diff).toContain('+++ rb-tenant-cutover v2');
    expect(diff.body.diff).toMatch(/^\+.*callback/m);
    expect(diff.body.added).toBeGreaterThan(0);
    expect((await request(member).get('/api/runbooks/rb-tenant-cutover/diff?from=1&to=9')).status).toBe(404);
    // Identical versions diff to nothing.
    expect((await request(member).get('/api/runbooks/rb-tenant-cutover/diff?from=2&to=2')).body.diff).toBe('');
  });
});

describe('proposing', () => {
  it('any signed-in person may suggest an edit; it is attributed to them, whatever the body claims', async () => {
    const res = await request(appAs(USERS.member!)).post('/api/runbooks/proposals').send({
      kind: 'edit', runbook_id: 'rb-tenant-cutover', markdown: EDIT_MD, rationale: 'Missing callback step.',
      source: { kind: 'run', person_id: 'p-999', run_ref: 'job-x' },
    });
    expect(res.status).toBe(201);
    expect(res.body.proposal.source).toEqual(expect.objectContaining({ kind: 'person', person_id: 'p-300' }));
    expect(res.body.proposal.source.run_ref).toBeUndefined();
    expect(res.body.proposal.base_version).toBe(1);
    expect(res.body.proposal.status).toBe('open');
    const detail = await request(appAs(USERS.member!)).get(`/api/runbooks/proposals/${res.body.proposal.id}`);
    expect(detail.body.diff.added).toBeGreaterThan(0);
    expect(detail.body.diff.text).toContain('@@');
    expect(detail.body.can_review).toBe(false);
  });

  it('refuses markdown that does not parse (line-numbered), an unchanged edit, and a bad shape', async () => {
    const member = appAs(USERS.member!);
    const bad = await request(member).post('/api/runbooks/proposals').send({ kind: 'edit', runbook_id: 'rb-tenant-cutover', markdown: 'not a runbook', rationale: 'x' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('PARSE');
    expect(bad.body.problems[0]).toEqual(expect.objectContaining({ line: expect.any(Number), message: expect.any(String) }));
    const v1 = (await store.getVersion('rb-tenant-cutover', 1))!.markdown;
    const same = await request(member).post('/api/runbooks/proposals').send({ kind: 'edit', runbook_id: 'rb-tenant-cutover', markdown: v1, rationale: 'x' });
    expect(same.status).toBe(422);
    expect(same.body.code).toBe('NO_CHANGE');
    expect((await request(member).post('/api/runbooks/proposals').send({ kind: 'edit', markdown: EDIT_MD, rationale: 'x' })).status).toBe(400);
    expect((await request(member).post('/api/runbooks/proposals').send({ kind: 'edit', runbook_id: 'rb-tenant-cutover', markdown: EDIT_MD })).status).toBe(400);
    expect((await request(member).post('/api/runbooks/proposals').send({ kind: 'edit', runbook_id: 'rb-gone', markdown: EDIT_MD, rationale: 'x' })).status).toBe(404);
    expect((await request(member).post('/api/runbooks/proposals').send({ kind: 'new', runbook_id: 'rb-x', markdown: NEW_MD, rationale: 'x' })).status).toBe(400);
  });

  it('a new proposal that resembles a published runbook lists it under `similar`', async () => {
    const res = await request(appAs(USERS.member!)).post('/api/runbooks/proposals').send({
      kind: 'new', markdown: NEW_MD.replace('Rerun a flaky test against its own diff', 'Rerun a flaky test against the diff that introduced it'), rationale: 'Found while debugging.',
    });
    expect(res.status).toBe(201);
    expect(res.body.proposal.runbook_id).toBeNull();
    expect(res.body.proposal.similar.map((s: { runbook_id: string }) => s.runbook_id)).toContain('rb-flaky-test-rerun-diff');
  });

  it('a box proposes with a signed lab envelope as a RUN; without one it is refused', async () => {
    await store.putBrief(assembleBrief({ run_ref: 'job-0042', assembled_at: '2026-10-14T00:00:00.000Z', framing: '', work_item: null, initiative: null, decisions: [], runbooks: [] }));
    const token = await mintRunToken('job-0042');
    const body = JSON.stringify({ kind: 'edit', runbook_id: 'rb-tenant-cutover', markdown: EDIT_MD, rationale: 'The run skipped step 2.', source: { run_ref: 'job-0042', session_id: 's-1', lab_experience_ids: ['exp-1'] } });
    const anon = appAs(null);
    const refused = await request(anon).post('/api/runbooks/proposals').set('content-type', 'application/json').send(body);
    expect(refused.status).toBe(401);

    const ok = await request(anon).post('/api/runbooks/proposals').set(boxHeaders('POST', '/api/runbooks/proposals', body, token)).send(body);
    expect(ok.status).toBe(201);
    expect(ok.body.proposal.source).toEqual({ kind: 'run', run_ref: 'job-0042', session_id: 's-1', lab_experience_ids: ['exp-1'] });

    // A replay of the same envelope is spent.
    const headers = boxHeaders('POST', '/api/runbooks/proposals', body, token);
    await request(anon).post('/api/runbooks/proposals').set(headers).send(body).expect(201);
    expect((await request(anon).post('/api/runbooks/proposals').set(headers).send(body)).status).toBe(401);

    // A box must say which run it is.
    const noRun = JSON.stringify({ kind: 'edit', runbook_id: 'rb-tenant-cutover', markdown: EDIT_MD, rationale: 'x' });
    expect((await request(anon).post('/api/runbooks/proposals').set(boxHeaders('POST', '/api/runbooks/proposals', noRun)).send(noRun)).status).toBe(400);
  });

  it('lists and filters proposals', async () => {
    const id = await propose(USERS.member!);
    const member = appAs(USERS.member!);
    const open = await request(member).get('/api/runbooks/proposals?status=open');
    expect(open.body.proposals.map((p: { id: string }) => p.id)).toEqual([id]);
    expect(open.body.proposals[0].lint).toEqual(expect.any(Array));
    expect((await request(member).get('/api/runbooks/proposals?status=accepted')).body.proposals).toEqual([]);
    expect((await request(member).get('/api/runbooks/proposals?runbook_id=rb-sso-new-origin')).body.proposals).toEqual([]);
    expect((await request(member).get('/api/runbooks/proposals?kind=new')).body.proposals).toEqual([]);
    expect((await request(member).get('/api/runbooks/rb-tenant-cutover')).body.runbook.open_proposals).toBe(1);
  });
});

describe('deciding: who may accept', () => {
  const accept = (user: TestUser, id: string, body: Record<string, unknown> = {}) =>
    request(appAs(user)).post(`/api/runbooks/proposals/${id}/accept`).send(body);

  it('a member can read and suggest but cannot accept (no ReviewRunbook)', async () => {
    const id = await propose(USERS.member!);
    const res = await accept(USERS.member!, id);
    expect(res.status).toBe(403);
    expect(res.body.action).toBe('ReviewRunbook');
    expect((await store.getProposal(id))!.status).toBe('open');
  });

  it('hr-admin and an anonymous caller are refused', async () => {
    const id = await propose(USERS.member!);
    expect((await accept(USERS.hr!, id)).status).toBe(403);
    expect((await request(appAs(null)).post(`/api/runbooks/proposals/${id}/accept`).send({})).status).toBe(401);
  });

  it('an SME attached to the runbook\'s initiative accepts: v2 is written and current', async () => {
    const id = await propose(USERS.member!);
    const res = await accept(USERS.smeAuth!, id, { note: 'Looks right.' });
    expect(res.status).toBe(200);
    expect(res.body.version).toEqual(expect.objectContaining({ version: 2, accepted_by: 'p-101', proposal_id: id }));
    expect(res.body.runbook.current_version).toBe(2);
    expect(res.body.proposal).toEqual(expect.objectContaining({ status: 'accepted', decided_by: 'p-101', note: 'Looks right.' }));
    expect((await store.getRunbook('rb-tenant-cutover'))!.current_version).toBe(2);
    expect((await store.getVersion('rb-tenant-cutover', 2))!.markdown).toBe(EDIT_MD);
  });

  it('an SME on ANOTHER initiative is refused, and nothing changes', async () => {
    const id = await propose(USERS.member!);
    const res = await accept(USERS.smeOther!, id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUT_OF_SCOPE');
    expect((await store.getRunbook('rb-tenant-cutover'))!.current_version).toBe(1);
    expect((await store.getProposal(id))!.status).toBe('open');
  });

  it('a program-owner attached to neither is refused too (ReviewRunbook is the floor, not the scope)', async () => {
    const id = await propose(USERS.member!);
    expect((await accept(USERS.programOwner!, id)).status).toBe(403);
  });

  it('the runbook\'s owner accepts', async () => {
    const id = await propose(USERS.member!);
    const res = await accept(USERS.owner!, id);
    expect(res.status).toBe(200);
    expect(res.body.version.accepted_by).toBe('p-100');
  });

  it('org-leader and admin override the scope', async () => {
    const a = await propose(USERS.member!);
    expect((await accept(USERS.leader!, a)).status).toBe(200);
    const b = await propose(USERS.member!, EDIT_MD_ALT, { base_version: 2 });
    expect((await accept(USERS.admin!, b)).status).toBe(200);
    expect((await store.getRunbook('rb-tenant-cutover'))!.current_version).toBe(3);
  });

  it('a proposer cannot accept their own proposal, even as an eligible SME', async () => {
    const id = await propose(USERS.proposer!);
    const res = await accept(USERS.proposer!, id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_ACCEPT');
    expect((await accept(USERS.smeAuth!, id)).status).toBe(200); // someone else can
  });

  it('a stale base_version is a 409 and the reviewer must rebase', async () => {
    const first = await propose(USERS.member!, EDIT_MD);
    const second = await propose(USERS.member!, EDIT_MD_ALT); // also written against v1
    expect((await accept(USERS.smeAuth!, first)).status).toBe(200);
    const stale = await accept(USERS.smeAuth!, second);
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual(expect.objectContaining({ code: 'VERSION_CONFLICT', base_version: 1, current_version: 2 }));
    expect((await store.getRunbook('rb-tenant-cutover'))!.current_version).toBe(2);
    expect((await store.getProposal(second))!.status).toBe('open');
  });

  it('a reviewer who saw an older version (expected_version) is refused', async () => {
    const id = await propose(USERS.member!);
    const res = await accept(USERS.smeAuth!, id, { expected_version: 7 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
  });

  it('accepting twice happens once: the second is 409, even when both race', async () => {
    const id = await propose(USERS.member!);
    const [a, b] = await Promise.all([accept(USERS.smeAuth!, id), accept(USERS.owner!, id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await store.getRunbook('rb-tenant-cutover'))!.current_version).toBe(2);
    const again = await accept(USERS.smeAuth!, id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PROPOSAL_CLOSED');
    expect(await store.listVersions('rb-tenant-cutover')).toHaveLength(2);
  });

  it('a proposal with lint errors cannot be accepted', async () => {
    const dirty = EDIT_MD.replace('Confirm sign-in works on the shim before you touch anything.', 'Confirm sign-in works on the shim; then flip it (+3 more).');
    const id = await propose(USERS.member!, dirty);
    const res = await accept(USERS.smeAuth!, id);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LINT');
    expect((await store.getRunbook('rb-tenant-cutover'))!.current_version).toBe(1);
  });

  it('accepting a NEW proposal: the reviewer names the scope and is checked against it', async () => {
    const created = await request(appAs(USERS.member!)).post('/api/runbooks/proposals').send({ kind: 'new', markdown: NEW_MD, rationale: 'Worth keeping.', source: { work_item_id: 'wi-auth-1' } });
    const id = created.body.proposal.id;
    // No scope named and the work item resolves to p-auth: an SME on p-auth may accept it.
    const sme = await accept(USERS.smeAuth!, id, {});
    expect(sme.status).toBe(201);
    expect(sme.body.runbook).toEqual(expect.objectContaining({ id: 'rb-rerun-a-flaky-test-against-its-own-diff', status: 'published', current_version: 1, owner_person_id: 'p-101' }));
    expect(sme.body.runbook.scope).toEqual({ kind: 'initiative', ref: 'p-auth' });

    // An SME cannot mint an org-wide runbook; ownership does not authorise creating one.
    const second = await request(appAs(USERS.member!)).post('/api/runbooks/proposals').send({ kind: 'new', markdown: NEW_MD, rationale: 'Again.' });
    const org = await accept(USERS.smeAuth!, second.body.proposal.id, { scope: { kind: 'org' }, id: 'rb-org-wide' });
    expect(org.status).toBe(403);
    expect((await accept(USERS.leader!, second.body.proposal.id, { scope: { kind: 'org' }, id: 'rb-org-wide', owner_person_id: 'p-002' })).status).toBe(201);
    expect((await store.getRunbook('rb-org-wide'))!.owner_person_id).toBe('p-002');

    // No scope and nothing to infer it from.
    const third = await request(appAs(USERS.member!)).post('/api/runbooks/proposals').send({ kind: 'new', markdown: NEW_MD, rationale: 'Third.' });
    expect((await accept(USERS.leader!, third.body.proposal.id, {})).status).toBe(400);
    expect((await accept(USERS.leader!, third.body.proposal.id, { scope: { kind: 'org' }, id: 'rb-org-wide' })).status).toBe(409); // id taken
  });

  it('accepting a retire proposal retires the runbook', async () => {
    const res = await request(appAs(USERS.member!)).post('/api/runbooks/proposals').send({ kind: 'retire', runbook_id: 'rb-tenant-cutover', rationale: 'The shim is gone.' });
    expect(res.status).toBe(201);
    expect(res.body.proposal.proposed).toBeNull();
    const accepted = await accept(USERS.owner!, res.body.proposal.id, { superseded_by: 'rb-sso-new-origin' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.runbook).toEqual(expect.objectContaining({ status: 'retired', retired: expect.objectContaining({ by: 'p-100', superseded_by: 'rb-sso-new-origin' }) }));
    // A retired runbook takes no more proposals.
    expect((await request(appAs(USERS.member!)).post('/api/runbooks/proposals').send({ kind: 'edit', runbook_id: 'rb-tenant-cutover', markdown: EDIT_MD, rationale: 'x' })).status).toBe(409);
  });
});

describe('reject and merge', () => {
  it('reject needs a note and the same scope; it is final', async () => {
    const id = await propose(USERS.member!);
    const reject = (u: TestUser, body: Record<string, unknown>) => request(appAs(u)).post(`/api/runbooks/proposals/${id}/reject`).send(body);
    expect((await reject(USERS.member!, { note: 'no' })).status).toBe(403);
    expect((await reject(USERS.smeOther!, { note: 'no' })).status).toBe(403);
    expect((await reject(USERS.smeAuth!, {})).status).toBe(400);
    const ok = await reject(USERS.smeAuth!, { note: 'Not how we do it.' });
    expect(ok.status).toBe(200);
    expect(ok.body.proposal).toEqual(expect.objectContaining({ status: 'rejected', note: 'Not how we do it.', decided_by: 'p-101' }));
    expect((await reject(USERS.smeAuth!, { note: 'again' })).status).toBe(409);
    expect((await request(appAs(USERS.smeAuth!)).post(`/api/runbooks/proposals/${id}/accept`).send({})).status).toBe(409);
  });

  it('merge re-targets the proposal as an edit on another runbook, keeping the source', async () => {
    const created = await request(appAs(USERS.member!)).post('/api/runbooks/proposals').send({ kind: 'new', markdown: NEW_MD, rationale: 'Looks new.' });
    const id = created.body.proposal.id;
    const merge = (u: TestUser, body: Record<string, unknown>) => request(appAs(u)).post(`/api/runbooks/proposals/${id}/merge`).send(body);
    expect((await merge(USERS.smeAuth!, { into: 'rb-sso-new-origin' })).status).toBe(403); // reviewer must own the TARGET
    expect((await merge(USERS.leader!, {})).status).toBe(400);
    expect((await merge(USERS.leader!, { into: 'rb-gone' })).status).toBe(404);
    const ok = await merge(USERS.leader!, { into: 'rb-flaky-test-rerun-diff', note: 'Same procedure.' });
    expect(ok.status).toBe(201);
    expect(ok.body.merged).toEqual(expect.objectContaining({ status: 'merged', merged_into: ok.body.proposal.id }));
    expect(ok.body.proposal).toEqual(expect.objectContaining({ kind: 'edit', runbook_id: 'rb-flaky-test-rerun-diff', base_version: 1, status: 'open' }));
    expect(ok.body.proposal.source.person_id).toBe('p-300');
    expect((await merge(USERS.leader!, { into: 'rb-flaky-test-rerun-diff' })).status).toBe(409);
  });
});

describe('retire and applications', () => {
  it('retire needs a reason and the same scope; a retired runbook leaves the default list', async () => {
    const retire = (u: TestUser, body: Record<string, unknown>) => request(appAs(u)).post('/api/runbooks/rb-tenant-cutover/retire').send(body);
    expect((await retire(USERS.member!, { reason: 'x' })).status).toBe(403);
    expect((await retire(USERS.smeOther!, { reason: 'x' })).status).toBe(403);
    expect((await retire(USERS.smeAuth!, {})).status).toBe(400);
    expect((await retire(USERS.smeAuth!, { reason: 'x', superseded_by: 'rb-nope' })).status).toBe(400);
    const ok = await retire(USERS.smeAuth!, { reason: 'The shim is gone.', superseded_by: 'rb-sso-new-origin' });
    expect(ok.status).toBe(200);
    expect(ok.body.runbook.retired).toEqual(expect.objectContaining({ by: 'p-101', reason: 'The shim is gone.', superseded_by: 'rb-sso-new-origin' }));
    expect((await retire(USERS.smeAuth!, { reason: 'again' })).status).toBe(409);
    const member = appAs(USERS.member!);
    expect((await request(member).get('/api/runbooks/')).body.runbooks.map((r: { id: string }) => r.id)).not.toContain('rb-tenant-cutover');
    expect((await request(member).get('/api/runbooks/?status=retired')).body.runbooks.map((r: { id: string }) => r.id)).toEqual(['rb-tenant-cutover']);
  });

  async function freezeBrief(runRef: string) {
    const candidates = await loadCandidates(store, Date.parse('2026-10-14T00:00:00Z'));
    const selected = selectRunbooks({ id: 'wi-1', title: 'Cut over tenant to Cognito', description: 'tenant cutover saml cognito', labels: ['cutover'], repo: null, initiative_id: 'p-auth', pinned_runbook_ids: ['rb-tenant-cutover'] }, candidates).selected;
    await store.putBrief({ ...assembleBrief({ run_ref: runRef, assembled_at: '2026-10-14T00:00:00.000Z', framing: '', work_item: null, initiative: null, decisions: [], runbooks: selected }), run_ref: runRef });
  }

  it('a box reports on a runbook it was given; health follows; a repeat is idempotent', async () => {
    await freezeBrief('job-7');
    await freezeBrief('job-9');
    const anon = appAs(null);
    const path = '/api/runbooks/rb-tenant-cutover/applications';
    const report = async (payload: Record<string, unknown>) => {
      const body = JSON.stringify(payload);
      return request(anon).post(path).set(boxHeaders('POST', path, body, await mintRunToken(String(payload['run_ref'])))).send(body);
    };
    const unsigned = JSON.stringify({ run_ref: 'job-7', outcome: 'followed' });
    expect((await request(anon).post(path).set('content-type', 'application/json').send(unsigned)).status).toBe(401);

    const ok = await report({ run_ref: 'job-7', outcome: 'followed' });
    expect(ok.status).toBe(201);
    expect(ok.body.application).toEqual(expect.objectContaining({ runbook_id: 'rb-tenant-cutover', version: 1, run_ref: 'job-7', outcome: 'followed', brief_id: 'brief-job-7' }));
    const again = await report({ run_ref: 'job-7', outcome: 'failed' });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.application.outcome).toBe('followed'); // the first report stands

    const member = appAs(USERS.member!);
    expect((await request(member).get('/api/runbooks/rb-tenant-cutover')).body.runbook.health.status).toBe('proven');
    const failed = await report({ run_ref: 'job-9', outcome: 'failed', failed_at_step: 2, note: 'sign-in still pointed to the old service' });
    expect(failed.body.application).toEqual(expect.objectContaining({ failed_at_step: 2, outcome: 'failed' }));
    const apps = await request(member).get('/api/runbooks/rb-tenant-cutover/applications?version=1');
    expect(apps.body.applications).toHaveLength(2);
    const health = (await request(member).get('/api/runbooks/rb-tenant-cutover')).body.runbook.health;
    expect(health.status).toBe('drifting');
    expect(health.warning).toContain('step 2');
  });

  it('refuses a report from a run that was not given the runbook, a wrong version, or a bad outcome', async () => {
    await freezeBrief('job-8');
    const anon = appAs(null);
    const post = async (path: string, payload: Record<string, unknown>) => {
      const body = JSON.stringify(payload);
      return request(anon).post(path).set(boxHeaders('POST', path, body, await mintRunToken(String(payload['run_ref'] ?? '')))).send(body);
    };
    expect((await post('/api/runbooks/rb-sso-new-origin/applications', { run_ref: 'job-8', outcome: 'followed' })).body.code).toBe('NOT_GIVEN');
    expect((await post('/api/runbooks/rb-tenant-cutover/applications', { run_ref: 'job-none', outcome: 'followed' })).status).toBe(409);
    expect((await post('/api/runbooks/rb-tenant-cutover/applications', { run_ref: 'job-8', outcome: 'followed', version: 5 })).body.code).toBe('VERSION_MISMATCH');
    expect((await post('/api/runbooks/rb-tenant-cutover/applications', { run_ref: 'job-8', outcome: 'maybe' })).status).toBe(400);
    expect((await post('/api/runbooks/rb-tenant-cutover/applications', { outcome: 'followed' })).status).toBe(400);
    expect((await post('/api/runbooks/rb-gone/applications', { run_ref: 'job-8', outcome: 'followed' })).status).toBe(404);
    // A person's session is not a credential for this route.
    expect((await request(appAs(USERS.admin!)).post('/api/runbooks/rb-tenant-cutover/applications').send({ run_ref: 'job-8', outcome: 'followed' })).status).toBe(401);
  });
});
