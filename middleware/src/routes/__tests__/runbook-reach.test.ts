// Who would receive a proposal: the reach block on the review read, and the module behind it.
// The real selector runs; the work comes from mocked providers so the open-only and scope bounds
// are the provider source's own.

jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../providers/identity.js', () => ({
  getUser: jest.fn(async (sub: string) => ({ personId: jest.requireActual('./runbook-world').personOf(sub) })),
}));

const mockWork: Array<Record<string, unknown>> = [];
const item = (id: string, projectId: string, title: string, over: Record<string, unknown> = {}) => ({
  id, key: `K-${id}`, projectId, projectName: projectId === 'p-auth' ? 'Auth Migration' : 'Other Initiative',
  title, description: null, status: 'open', labels: [], runbookPins: [], updatedAt: '2026-11-01T00:00:00.000Z', ...over,
});
jest.mock('../../providers/projects.js', () => ({
  getProject: jest.fn(async (id: string) => jest.requireActual('./runbook-world').PROJECTS[id] ?? null),
  listProjects: jest.fn(async () => Object.values(jest.requireActual('./runbook-world').PROJECTS)),
}));
jest.mock('../../providers/work-items.js', () => ({
  getWorkItem: jest.fn(async (id: string) => mockWork.find((w) => w['id'] === id) ?? null),
  getProjectWorkItems: jest.fn(async (pid: string) => mockWork.filter((w) => w['projectId'] === pid)),
  searchWorkItems: jest.fn(async (o: { status?: string; limit?: number }) => mockWork.filter((w) => !o.status || w['status'] === o.status).slice(0, o.limit ?? 50)),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { createRunbooksRouter } from '../runbooks.js';
import { errorHandler } from '../../lib/async-handler.js';
import { proposalReach, REACH_MAX_ITEMS, REACH_SCAN_CAP, type ReachSource, type ReachWorkItem } from '../../lib/runbooks/reach.js';
import { loadCandidates } from '../../lib/session-brief-preview.js';
import { renderRunbook, type RunbookProposal, type RunbookStore, type RunbookDoc } from '../../lib/runbooks/index.js';
import { flakyRerunDiff, tenantCutoverV1, tenantCutoverV2 } from '../../lib/runbooks/__tests__/fixtures/good.js';
import { EDIT_MD, USERS, seededStore, type TestUser } from './runbook-world.js';

let store: RunbookStore;
beforeEach(() => { store = seededStore(); mockWork.length = 0; });

function appAs(user: TestUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { sub: user.sub, role: user.role, tenant: user.tenant, grants: { [user.tenant]: [user.role] }, iat: 0 };
    next();
  });
  app.use('/api/runbooks', createRunbooksRouter({ store: () => store }));
  app.use(errorHandler);
  return app;
}

async function fileEdit(): Promise<string> {
  const res = await request(appAs(USERS.member!)).post('/api/runbooks/proposals').send({ kind: 'edit', runbook_id: 'rb-tenant-cutover', markdown: EDIT_MD, rationale: 'Missing callback step.' });
  expect(res.status).toBe(201);
  return res.body.proposal.id;
}

describe('the reach block on a proposal read', () => {
  it('lists the open work an edit would reach, with a link key, and leaves done and cancelled work out', async () => {
    mockWork.push(
      item('wi-1', 'p-auth', 'Cut tenant acme over to Cognito', { labels: ['cutover'] }),
      item('wi-2', 'p-auth', 'Cut tenant globex over from SAML', { status: 'in_progress' }),
      item('wi-3', 'p-auth', 'Cut tenant initech over', { status: 'done', labels: ['cutover'] }),
      item('wi-4', 'p-auth', 'Cut tenant umbrella over', { status: 'cancelled', labels: ['cutover'] }),
      item('wi-5', 'p-auth', 'Order office plants'),
      item('wi-6', 'p-other', 'Cut tenant hooli over', { labels: ['cutover'] }), // another initiative: out of the runbook's scope
    );
    const pid = await fileEdit();
    const res = await request(appAs(USERS.member!)).get(`/api/runbooks/proposals/${pid}`);
    expect(res.status).toBe(200);
    expect(res.body.reach.mode).toBe('receive');
    expect(res.body.reach.items.map((i: { id: string }) => i.id).sort()).toEqual(['wi-1', 'wi-2']);
    expect(res.body.reach.items[0]).toEqual({ id: expect.any(String), key: expect.stringMatching(/^K-/), title: expect.any(String), initiative: { id: 'p-auth', name: 'Auth Migration' }, outcome: 'chosen' });
    expect(res.body.reach.total).toBe(2);
    expect(res.body.reach.capped).toBe(false);
  });

  it('an empty reach is an empty list, not a missing block', async () => {
    mockWork.push(item('wi-5', 'p-auth', 'Order office plants'));
    const res = await request(appAs(USERS.member!)).get(`/api/runbooks/proposals/${await fileEdit()}`);
    expect(res.body.reach).toEqual(expect.objectContaining({ items: [], total: 0 }));
  });

  it('is shown to every orgiq reader of the proposal and to an admin, and to no one outside the tenant', async () => {
    mockWork.push(item('wi-1', 'p-auth', 'Cut tenant acme over', { labels: ['cutover'] }));
    const pid = await fileEdit();
    for (const who of [USERS.member!, USERS.owner!, USERS.leader!, USERS.admin!]) {
      const res = await request(appAs(who)).get(`/api/runbooks/proposals/${pid}`);
      expect(res.status).toBe(200);
      expect(res.body.reach.total).toBe(1);
    }
    const out = await request(appAs(USERS.assessor!)).get(`/api/runbooks/proposals/${pid}`);
    expect(out.status).toBe(403);
    expect(out.body.reach).toBeUndefined();
  });

  it('shows the work the work-item reads show: a work item an orgiq member cannot read is not named', async () => {
    // The work-item reads are tenant-open, so the reviewer sees exactly the provider's open items
    // for the scope; an item on an initiative outside the runbook's scope never appears.
    mockWork.push(item('wi-6', 'p-other', 'Cut tenant hooli over', { labels: ['cutover'] }));
    const res = await request(appAs(USERS.member!)).get(`/api/runbooks/proposals/${await fileEdit()}`);
    expect(res.body.reach.items).toEqual([]);
  });
});

// ── the module, against a fake source ───────────────────────────────────────

const AT = '2026-11-01T00:00:00.000Z';
function source(rows: ReachWorkItem[]): ReachSource {
  const sorted = [...rows].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return {
    initiatives: async () => [{ id: 'p-auth', name: 'Auth Migration', repo: 'connorhoehn/orgiq-auth-service' }, { id: 'p-other', name: 'Other Initiative', repo: 'connorhoehn/orgiq-other' }],
    openWork: async (id, limit) => sorted.filter((r) => r.projectId === id).slice(0, limit),
    openWorkOrgWide: async (limit) => sorted.slice(0, limit),
  };
}
const row = (id: string, projectId: string, title: string, over: Partial<ReachWorkItem> = {}): ReachWorkItem => ({
  id, key: `K-${id}`, title, description: null, labels: [], projectId, projectName: projectId, runbookPins: [], updatedAt: AT, ...over,
});
const proposal = (over: Partial<RunbookProposal>): RunbookProposal => ({
  id: 'prop-1', kind: 'new', runbook_id: null, base_version: null, proposed: null, status: 'open', created_at: AT,
  source: { kind: 'person', person_id: 'p-300' }, rationale: 'x', similar: [], ...over,
} as unknown as RunbookProposal);
const flakyDoc = flakyRerunDiff as RunbookDoc;

async function input(p: RunbookProposal, rows: ReachWorkItem[], targetId: string | null = null, scope = { kind: 'org' as const, ref: null }) {
  const target = targetId ? await store.getRunbook(targetId) : null;
  return {
    proposal: p, target, newScope: scope, source: source(rows),
    candidates: await loadCandidates(store, Date.parse(AT)),
    targetVersion: target ? await store.getVersion(target.id, target.current_version) : null,
  };
}

describe('proposalReach', () => {
  it('a new org-wide runbook reaches the open work that shares its labels or terms, in any initiative', async () => {
    const rows = [row('a', 'p-auth', 'Fix a flaky test in CI', { labels: ['flaky'] }), row('b', 'p-other', 'Rerun the flaky test', {}), row('c', 'p-auth', 'Order plants')];
    const r = (await proposalReach(await input(proposal({ proposed: flakyDoc }), rows)))!;
    expect(r.items.map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect(r.items.every((i) => i.outcome === 'chosen')).toBe(true);
  });

  it('marks a match that lost on the two-runbook limit as passed over', async () => {
    // Pin two other runbooks first: the proposed one matches but ranks third.
    const rows = [row('a', 'p-auth', 'Fix a flaky test', { labels: ['flaky'], runbookPins: ['rb-tenant-cutover', 'rb-sso-new-origin'] })];
    const r = (await proposalReach(await input(proposal({ proposed: flakyDoc }), rows)))!;
    expect(r.items).toEqual([expect.objectContaining({ id: 'a', outcome: 'passed_over' })]);
  });

  it('a retire shows what would lose the runbook: the work it is given to today, not what it was passed over for', async () => {
    const rows = [
      row('a', 'p-auth', 'Cut tenant acme over', { labels: ['cutover'] }),
      row('b', 'p-auth', 'Cut tenant globex over', { labels: ['cutover'], runbookPins: ['rb-sso-new-origin', 'rb-flaky-test-rerun-diff'] }),
      row('c', 'p-auth', 'Order plants'),
    ];
    const r = (await proposalReach(await input(proposal({ kind: 'retire', runbook_id: 'rb-tenant-cutover' }), rows, 'rb-tenant-cutover')))!;
    expect(r.mode).toBe('lose');
    expect(r.items.map((i) => i.id)).toEqual(['a']);
  });

  it('a restore shows what would gain a retired runbook', async () => {
    const t = (await store.getRunbook('rb-tenant-cutover'))!;
    await store.putRunbook({ ...t, status: 'retired' }, t.updated_at);
    const rows = [row('a', 'p-auth', 'Cut tenant acme over', { labels: ['cutover'] }), row('c', 'p-auth', 'Order plants')];
    const r = (await proposalReach(await input(proposal({ kind: 'restore', runbook_id: 'rb-tenant-cutover' }), rows, 'rb-tenant-cutover')))!;
    expect(r.mode).toBe('gain');
    expect(r.items.map((i) => i.id)).toEqual(['a']);
  });

  it('an edit lists nothing for work that shares no label or term with the proposed text', async () => {
    const rows = [row('a', 'p-auth', 'Order office plants')];
    const r = (await proposalReach(await input(proposal({ kind: 'edit', runbook_id: 'rb-tenant-cutover', base_version: 1, proposed: tenantCutoverV2 as RunbookDoc }), rows, 'rb-tenant-cutover')))!;
    expect(r.items).toEqual([]);
    void tenantCutoverV1; void renderRunbook;
  });

  it('lists at most 20 and counts them all; an org-wide scan stops at 200 open items and says so', async () => {
    const many = Array.from({ length: 30 }, (_, n) => row(`m${n}`, 'p-auth', `Fix flaky test ${n}`, { labels: ['flaky'] }));
    const r = (await proposalReach(await input(proposal({ proposed: flakyDoc }), many)))!;
    expect(r.items).toHaveLength(REACH_MAX_ITEMS);
    expect(r.total).toBe(30);
    expect(r.capped).toBe(false);
    const huge = Array.from({ length: REACH_SCAN_CAP + 40 }, (_, n) => row(`h${n}`, 'p-auth', `Fix flaky test ${n}`, { labels: ['flaky'] }));
    const big = (await proposalReach(await input(proposal({ proposed: flakyDoc }), huge)))!;
    expect(big.scanned).toBe(REACH_SCAN_CAP);
    expect(big.total).toBe(REACH_SCAN_CAP);
    expect(big.capped).toBe(true);
  });

  it('a repo scope looks only at the initiatives working in that repository', async () => {
    const rows = [row('a', 'p-auth', 'Fix flaky test', { labels: ['flaky'] }), row('b', 'p-other', 'Fix flaky test', { labels: ['flaky'] })];
    const r = (await proposalReach(await input(proposal({ proposed: flakyDoc }), rows, null, { kind: 'repo', ref: 'connorhoehn/orgiq-other' } as never)))!;
    expect(r.items.map((i) => i.id)).toEqual(['b']);
  });
});
