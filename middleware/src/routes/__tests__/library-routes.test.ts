// The asset library — /api/library (routes/library.ts).
//
// The provider is mocked; `lib/prompt-contract.js` is NOT, because the whole
// point of the detail route is that readiness is COMPUTED from the asset's
// current state rather than stored. Mocking the decision would leave nothing
// under test.
//
// What is pinned:
//   * the list envelope (`assets` / `facets` / `total`) and that facets
//     describe the whole catalog so a filter can be widened again,
//   * the detail envelope (`asset` / `readiness` / `related`) and every key
//     of the readiness CHECKLIST the drawer renders — "not shippable" alone
//     is not actionable, so each check has to survive,
//   * the route's central correctness claim: the ASSET's kind/tier override
//     the contract's own copy. A drifted contract tier must not let a
//     sandbox-labelled contract wave an endpoint asset through,
//   * the 404 branch.

jest.mock('../../providers/prompt-library.js', () => ({
  listAssets: jest.fn(),
  getAsset: jest.fn(),
  relatedAssets: jest.fn(),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { libraryRouter } from '../library.js';
import { errorHandler } from '../../lib/async-handler.js';
import { listAssets, getAsset, relatedAssets } from '../../providers/prompt-library.js';

const listMock = listAssets as unknown as jest.Mock;
const getMock = getAsset as unknown as jest.Mock;
const relatedMock = relatedAssets as unknown as jest.Mock;

function asset(over: Record<string, unknown> = {}) {
  return {
    id: 'asset-1', name: 'Supervisor system prompt', description: 'routes a question',
    kind: 'agent', tier: 'endpoint', roles: ['sme'], tags: ['supervisor'],
    ownerName: 'Nora Vance', version: '3', lifecycleStatus: 'live',
    template: 'Answer {{question}} for {{role}}.',
    contract: {
      // Deliberately drifted: the contract claims sandbox, the asset says
      // endpoint. The route must judge at the ASSET's tier.
      tier: 'sandbox', kind: 'prompt', guardrailId: 'gr-1',
      variables: [{ name: 'question' }, { name: 'role' }],
    },
    evalPassRate: 0.95, usedBy: ['orgiq-supervisor'], signoffs: 2,
    updatedAt: '2026-08-20T09:00:00Z',
    ...over,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/library', libraryRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  listMock.mockReset(); getMock.mockReset(); relatedMock.mockReset();
  relatedMock.mockResolvedValue([]);
});

describe('GET /api/library', () => {
  it('returns assets beside whole-catalog facets and a filtered total', async () => {
    listMock.mockResolvedValue({
      assets: [asset()],
      facets: { kind: { agent: 1, skill: 4 }, tier: { endpoint: 2 }, role: { sme: 3 } },
      total: 1,
    });
    const res = await request(buildApp()).get('/api/library?kind=agent');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['assets', 'facets', 'total']);
    expect(Object.keys(res.body.facets).sort()).toEqual(['kind', 'role', 'tier']);
    // The facet count exceeds the filtered result on purpose — a facet that
    // collapsed to the current filter could never widen the search again.
    expect(res.body.facets.kind.skill).toBe(4);
  });

  it('defaults every facet to "all" and the limit to 100', async () => {
    listMock.mockResolvedValue({ assets: [], facets: { kind: {}, tier: {}, role: {} }, total: 0 });
    await request(buildApp()).get('/api/library');
    expect(listMock).toHaveBeenCalledWith({ q: '', kind: 'all', tier: 'all', role: 'all', limit: 100 });
  });

  it('falls back to 100 on a non-numeric limit and forwards the query text', async () => {
    listMock.mockResolvedValue({ assets: [], facets: { kind: {}, tier: {}, role: {} }, total: 0 });
    await request(buildApp()).get('/api/library?limit=abc&q=guardrail&tier=internal');
    expect(listMock).toHaveBeenCalledWith({
      q: 'guardrail', kind: 'all', tier: 'internal', role: 'all', limit: 100,
    });
  });

  it('serves an empty catalog with empty facets rather than a 404', async () => {
    listMock.mockResolvedValue({ assets: [], facets: { kind: {}, tier: {}, role: {} }, total: 0 });
    const res = await request(buildApp()).get('/api/library');
    expect(res.status).toBe(200);
    expect(res.body.assets).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});

describe('GET /api/library/:id', () => {
  it('ships the asset, a computed readiness checklist, and its neighbours', async () => {
    getMock.mockResolvedValue(asset());
    relatedMock.mockResolvedValue([{ asset: asset({ id: 'asset-2' }), score: 0.4, reason: 'shared tag: supervisor' }]);

    const res = await request(buildApp()).get('/api/library/asset-1');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['asset', 'readiness', 'related']);
    expect(Object.keys(res.body.readiness.checks).sort()).toEqual([
      'contractComplete', 'evalPassRate', 'evaluated', 'guardrailBound', 'hasOwner', 'signoffs', 'undeclared',
    ]);
    expect(res.body.readiness.ok).toBe(true);
    expect(res.body.readiness.tier).toBe('endpoint');
    expect(res.body.readiness.checks).toMatchObject({
      contractComplete: true, undeclared: [], hasOwner: true,
      evaluated: true, evalPassRate: 0.95, guardrailBound: true, signoffs: 2,
    });
    // Every neighbour carries the reason it is one.
    expect(res.body.related[0].reason).toBe('shared tag: supervisor');
  });

  it('judges at the ASSET\'s tier, not the contract\'s stale copy of it', async () => {
    // An endpoint asset with no owner is NOT shippable. If the contract's
    // `tier: 'sandbox'` were honoured, decideDeploy would wave it through —
    // the one failure a release gate must never have.
    getMock.mockResolvedValue(asset({ ownerName: null }));
    const res = await request(buildApp()).get('/api/library/asset-1');
    expect(res.body.readiness.ok).toBe(false);
    expect(res.body.readiness.reason).toMatch(/no owner/);
    expect(res.body.readiness.tier).toBe('endpoint');
  });

  it('names an undeclared template variable rather than just failing', async () => {
    getMock.mockResolvedValue(asset({
      template: 'Answer {{question}} as {{persona}}.',
      contract: { tier: 'sandbox', kind: 'prompt', guardrailId: 'gr-1', variables: [{ name: 'question' }] },
    }));
    const res = await request(buildApp()).get('/api/library/asset-1');
    expect(res.body.readiness.ok).toBe(false);
    expect(res.body.readiness.checks.contractComplete).toBe(false);
    expect(res.body.readiness.checks.undeclared).toEqual(['persona']);
    expect(res.body.readiness.reason).toMatch(/persona/);
  });

  it('reports a missing eval baseline as unevaluated, not as a pass rate of 0', async () => {
    getMock.mockResolvedValue(asset({ evalPassRate: null }));
    const res = await request(buildApp()).get('/api/library/asset-1');
    expect(res.body.readiness.checks.evaluated).toBe(false);
    expect(res.body.readiness.checks.evalPassRate).toBeNull();
  });

  it('404s an unknown asset without asking for neighbours', async () => {
    getMock.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/library/asset-x');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/asset not found/);
    expect(relatedMock).not.toHaveBeenCalled();
  });
});
