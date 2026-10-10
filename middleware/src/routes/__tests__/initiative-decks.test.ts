// Orgiq initiative status decks (docs/agentic-flows-migration.md slice 6):
// every number on a slide equals the initiative's own rows, budget-tier
// redaction per role, the authz matrix, CAS 409, download headers, narrative
// fallback and mock reset. Open-mode authz over a seed-matrix stand-in, real mock fixtures.

// Sessions here are hand-built (no directory rows): the deck write rule's fresh
// directory re-read (live-principal.ts) is the identity, its Cedar decisions stay real.
jest.mock('../../lib/live-principal.js', () => ({
  ...jest.requireActual('../../lib/live-principal.js'),
  currentLiveSession: async (session: unknown) => session,
}));
jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true, agentcore: true } },
}));
// The seed matrix for the two actions these routes ask (member: none; sme: dispatch
// but no budgets; program-owner / org-leader / hr-admin: both; admin: wildcard).
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'member', tenant: 'orgiq', label: 'Member', summary: '', capabilities: ['Search'] },
    { id: 'sme', tenant: 'orgiq', label: 'SME', summary: '', capabilities: ['Search', 'DispatchAgentRun', 'ManageSprints'] },
    { id: 'program-owner', tenant: 'orgiq', label: 'PO', summary: '', capabilities: ['DispatchAgentRun', 'ManageBudgets'] },
    { id: 'org-leader', tenant: 'orgiq', label: 'OL', summary: '', capabilities: ['DispatchAgentRun', 'ManageBudgets'] },
    { id: 'hr-admin', tenant: 'orgiq', label: 'HR', summary: '', capabilities: ['DispatchAgentRun', 'ManageBudgets'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import JSZip from 'jszip';
import request from '../../test-support/http.js';
import { initiativeDecksRouter } from '../initiative-decks.js';
import { mockControlRouter } from '../mock-control.js';
import { requireTenant } from '../../lib/authz.js';
import { errorHandler } from '../../lib/async-handler.js';
import type { Session } from '../../lib/session.js';
import { initiativeDecksFixture, initiativeDeckRevisionsFixture } from '../../mock/initiative-decks.js';
import { getProjectWorkItems, getProjectDecisions } from '../../providers/work-items.js';
import { listSprints } from '../../providers/sprints.js';
import { getBudget, getMaintenance30d, listGrants } from '../../providers/budgets.js';
import { buildInitiativeDeckFacts, money, isOpenItem } from '../../lib/initiative-deck/facts.js';
import { loadInitiativeDeckSource } from '../../providers/initiative-decks.js';
import type { DeckSpec } from '@connorhoehnslalom/realtime-modules/deck';
import { config } from '../../config.js';
import { agentcore } from '../../providers/index.js';
import { hidePptxNodeDetection } from '../../test-support/pptxTestEnv.js';
import { statusLabel } from '../../lib/initiative-deck/facts.js';

const PID = 'p-auth-migration';
const BASE = '/api/initiative-decks';

let restoreRelease: () => void;
beforeAll(() => { restoreRelease = hidePptxNodeDetection(); });
afterAll(() => restoreRelease());
beforeEach(() => { initiativeDecksFixture.reset(); initiativeDeckRevisionsFixture.reset(); });

function appAs(session: Partial<Session>) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.session = { sub: 'u-test', iat: 0, grants: {}, ...session } as Session; next(); });
  app.use(BASE, requireTenant('orgiq'), initiativeDecksRouter);
  app.use(mockControlRouter);
  app.use(errorHandler);
  return app;
}
const as = (role: string) => appAs({ role: role as Session['role'], tenant: 'orgiq', sub: `u-${role}` });

const slideText = (spec: DeckSpec, id: string): string => {
  const s = spec.slides.find((x) => x.id === id);
  return s ? [...(s.bullets ?? []), ...(s.columns?.flat() ?? [])].join('\n') : '';
};
const allText = (spec: DeckSpec): string => spec.slides.map((s) => `${s.title}\n${slideText(spec, s.id)}\n${s.notes ?? ''}`).join('\n');

async function build(app: express.Express, body: Record<string, unknown> = {}) {
  const res = await request(app).post(`${BASE}/projects/${PID}`).send(body);
  expect(res.status).toBe(201);
  const spec: DeckSpec = (await request(app).get(`${BASE}/${res.body.deckId}/revisions/${res.body.revisionId}/spec`)).body;
  return { ...res.body, spec } as { deckId: string; revisionId: string; includesBudget: boolean; narrative: { status: string }; spec: DeckSpec };
}

describe('initiative status deck — facts equal the initiative data', () => {
  it('work, point, estimate, sprint and decision slides state exactly the rows', async () => {
    const { spec } = await build(as('org-leader'));
    const items = await getProjectWorkItems(PID);
    expect(items.length).toBeGreaterThan(0);
    const open = items.filter(isOpenItem);
    const done = items.filter((i) => i.status === 'done');
    const pts = (xs: typeof items) => Math.round(xs.reduce((t, i) => t + (i.storyPoints ?? 0), 0) * 1e4) / 1e4;
    const est = Math.round(open.reduce((t, i) => t + (i.estimatedCostUsd ?? 0), 0) * 1e4) / 1e4;
    const sprints = await listSprints({ orgProjectId: PID, limit: 200 });
    const decisions = await getProjectDecisions(PID);

    const summary = slideText(spec, 'summary');
    expect(summary).toContain(`Work items: ${items.length} total · ${open.length} open · ${done.length} done`);
    expect(summary).toContain(`Story points: ${pts(done)} of ${pts(items.filter((i) => i.status !== 'cancelled'))} done`);
    expect(summary).toContain(`Estimated cost of open work: ${money(est)}`);
    expect(summary).toContain(`Sprints: ${sprints.length}`);
    expect(summary).toContain(`Open decisions: ${decisions.filter((d) => d.status === 'open' || d.status === 'escalated').length}`);

    const chart = spec.slides.find((s) => s.id === 'work-status')!.chart!;
    expect(chart.series[0]!.values).toEqual(['open', 'in_progress', 'in_review', 'done', 'cancelled'].map((st) => items.filter((i) => i.status === st).length));
    const byType = slideText(spec, 'work-type');
    for (const t of ['epic', 'story', 'bug'] as const) {
      const of = items.filter((i) => i.type === t);
      expect(byType).toContain(`${of.length} · ${of.filter(isOpenItem).length} open · ${pts(of)} points`);
    }
    for (const sp of sprints.slice(0, 7)) {
      expect(slideText(spec, 'sprints')).toContain(`${sp.name} — ${statusLabel(sp.status, '')}`);
      expect(slideText(spec, 'sprints')).toContain(`${sp.doneItemCount}/${sp.itemCount} items · ${sp.pointsDone}/${sp.pointsTotal} points`);
    }
    expect(spec.slides.every((s) => s.sources.length > 0)).toBe(true);
  });

  it('a budget reader gets allocation, spend, envelope and 30-day maintenance figures from the ledger', async () => {
    const { spec, includesBudget } = await build(as('org-leader'));
    expect(includesBudget).toBe(true);
    const row = (await getBudget(PID))!;
    const floor = await getMaintenance30d(PID);
    const grants = await listGrants(PID);
    expect(row).toBeTruthy();
    const budget = slideText(spec, 'budget');
    expect(budget).toContain(`Monthly allocation: ${row.allocatedUsd === null ? 'none set' : money(row.allocatedUsd)}`);
    expect(budget).toContain(`Spent this period: ${money(row.spentThisPeriodUsd)} across`);
    expect(budget).toContain(`Maintenance floor, last 30 days: ${money(floor.costUsd)} across ${floor.cronRuns} cron run`);
    if (grants.length) {
      const env = slideText(spec, 'envelopes');
      for (const g of grants.slice(0, 7)) expect(env).toContain(`${g.granteeName ?? g.granteePersonId} — ${g.sprintName ?? 'no sprint'} · ${money(g.allocatedUsd)} granted`);
    }
  });

  it('is deterministic: the same source yields the same deck', async () => {
    const source = (await loadInitiativeDeckSource(PID, true))!;
    expect(buildInitiativeDeckFacts(source).spec).toEqual(buildInitiativeDeckFacts(source).spec);
  });

  it('an unknown initiative is 404', async () => {
    expect((await request(as('sme')).post(`${BASE}/projects/p-nope`).send({})).status).toBe(404);
  });
});

describe('initiative status deck — budget-tier redaction', () => {
  it('an SME (no budget read) gets a deck with no money slide and no budget figure', async () => {
    const { spec, includesBudget } = await build(as('sme'));
    expect(includesBudget).toBe(false);
    const ids = spec.slides.map((s) => s.id);
    expect(ids).not.toContain('budget');
    expect(ids).not.toContain('envelopes');
    const row = (await getBudget(PID))!;
    const text = allText(spec);
    expect(text).not.toMatch(/allocation|Maintenance floor|envelope/i);
    if (row.allocatedUsd !== null) expect(text).not.toContain(money(row.allocatedUsd));
    expect(text).not.toContain(money(row.spentThisPeriodUsd) + ' across');
  });

  it('an SME asking for includeBudget gets no money anyway', async () => {
    const { includesBudget, spec } = await build(as('sme'), { includeBudget: true });
    expect(includesBudget).toBe(false);
    expect(spec.slides.map((s) => s.id)).not.toContain('budget');
  });

  it('a budget reader may opt out of money; that deck is open to everyone', async () => {
    const out = await build(as('program-owner'), { includeBudget: false });
    expect(out.includesBudget).toBe(false);
    expect(out.spec.slides.map((s) => s.id)).not.toContain('budget');
    expect((await request(as('member')).get(`${BASE}/${out.deckId}`)).status).toBe(200);
  });

  it('a deck with budget figures is invisible to a non-reader: list, detail, spec, preview, file, save', async () => {
    const made = await build(as('org-leader'));
    expect(made.includesBudget).toBe(true);
    for (const role of ['sme', 'member']) {
      const app = as(role);
      expect((await request(app).get(BASE)).body).toEqual([]);
      expect((await request(app).get(`${BASE}/${made.deckId}`)).status).toBe(404);
      expect((await request(app).get(`${BASE}/${made.deckId}/revisions/${made.revisionId}/spec`)).status).toBe(404);
      expect((await request(app).post(`${BASE}/${made.deckId}/preview`).send({ spec: made.spec })).status).toBe(404);
      expect((await request(app).get(`${BASE}/${made.deckId}/revisions/${made.revisionId}/file`)).status).toBe(404);
    }
    const sme = as('sme');
    expect((await request(sme).post(`${BASE}/${made.deckId}/revisions`).send({ spec: made.spec, baseRevisionId: made.revisionId })).status).toBe(404);
    for (const role of ['org-leader', 'hr-admin', 'program-owner', 'admin']) {
      const list = (await request(as(role)).get(`${BASE}?projectId=${PID}`)).body as Array<{ id: string }>;
      expect(list.map((d) => d.id)).toContain(made.deckId);
    }
  });

  it('a non-reader still sees decks without budget figures', async () => {
    const mine = await build(as('sme'));
    const list = (await request(as('member')).get(`${BASE}?projectId=${PID}`)).body as Array<{ id: string; includesBudget: boolean }>;
    expect(list).toEqual([expect.objectContaining({ id: mine.deckId, includesBudget: false })]);
  });
});

describe('initiative status deck — narrative', () => {
  it('the offline drafter writes prose with verbatim spans; fact bullets stay identical', async () => {
    const app = as('program-owner');
    const plain = await build(app);
    const nar = await build(app, { narrative: true });
    expect(nar.narrative.status).not.toBe('none');
    expect(['applied', 'partial', 'fallback']).toContain(nar.narrative.status);
    for (const id of ['work-type', 'sprints']) {
      expect(nar.spec.slides.find((s) => s.id === id)?.bullets).toEqual(plain.spec.slides.find((s) => s.id === id)?.bullets);
    }
    expect(nar.spec.slides.find((s) => s.id === 'summary')!.bullets!.slice(0, 5)).toEqual(plain.spec.slides.find((s) => s.id === 'summary')!.bullets!.slice(0, 5));
  });
});

describe('initiative status deck — authz', () => {
  it('DispatchAgentRun roles generate; a member reads but cannot generate or edit', async () => {
    for (const role of ['sme', 'program-owner', 'org-leader', 'hr-admin', 'admin']) {
      expect((await request(as(role)).post(`${BASE}/projects/${PID}`).send({})).status).toBe(201);
    }
    expect((await request(as('member')).post(`${BASE}/projects/${PID}`).send({})).status).toBe(403);
    const made = await build(as('sme'));
    const member = as('member');
    expect((await request(member).get(`${BASE}/${made.deckId}`)).status).toBe(200);
    expect((await request(member).post(`${BASE}/${made.deckId}/revisions`).send({ spec: made.spec, baseRevisionId: made.revisionId })).status).toBe(403);
    expect((await request(member).post(`${BASE}/${made.deckId}/preview`).send({ spec: made.spec })).status).toBe(200);
  });

  it('other tenants are refused before any handler', async () => {
    const assessment = appAs({ role: 'assessor' as Session['role'], tenant: 'assessment', sub: 'u-asha' });
    const pipelines = appAs({ role: 'author' as Session['role'], tenant: 'pipelines', sub: 'u-ines' });
    for (const app of [assessment, pipelines]) {
      expect((await request(app).get(BASE)).status).toBe(403);
      expect((await request(app).post(`${BASE}/projects/${PID}`).send({})).status).toBe(403);
    }
  });

  it('an unsigned request never sees a budget deck', async () => {
    const app = express();
    app.use(express.json());
    app.use(BASE, initiativeDecksRouter);
    app.use(errorHandler);
    const res = await request(app).get(BASE);
    expect([401, 200]).toContain(res.status); // demo fallback may apply outside production
    expect(JSON.stringify(res.body)).not.toContain('includesBudget":true');
  });
});

describe('initiative status deck — revisions, preview, download', () => {
  it('saves a person edit; a stale base is 409; reset clears decks', async () => {
    const app = as('org-leader');
    const made = await build(app);
    const edited = { ...made.spec, slides: made.spec.slides.map((s) => (s.id === 'summary' ? { ...s, title: 'Executive view' } : s)) };
    const saved = await request(app).post(`${BASE}/${made.deckId}/revisions`).send({ spec: edited, baseRevisionId: made.revisionId, label: 'Retitled' });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ label: 'Retitled', producedBy: 'person:u-org-leader' });
    const stale = await request(app).post(`${BASE}/${made.deckId}/revisions`).send({ spec: edited, baseRevisionId: made.revisionId });
    expect(stale.status).toBe(409);
    expect(stale.body.activeRevisionId).toBe(saved.body.id);
    expect((await request(app).post(`${BASE}/${made.deckId}/revisions`).send({ spec: { title: '', slides: [] }, baseRevisionId: saved.body.id })).status).toBe(400);
    const detail = (await request(app).get(`${BASE}/${made.deckId}`)).body;
    expect(detail.revisions.map((r: { id: string }) => r.id)).toEqual([saved.body.id, made.revisionId]);
    expect(detail.activeRevisionId).toBe(saved.body.id);
    expect((await request(app).post('/api/__mock/reset')).status).toBeLessThan(300);
    expect((await request(app).get(BASE)).body).toEqual([]);
  });

  it('previews svg per slide and downloads a valid .pptx attachment', async () => {
    const app = as('org-leader');
    const made = await build(app);
    const preview = await request(app).post(`${BASE}/${made.deckId}/preview`).send({ spec: made.spec });
    expect(preview.status).toBe(200);
    expect(preview.body.slides.length).toBe(made.spec.slides.length + 1); // + generated Sources slide
    const file = await request(app).get(`${BASE}/${made.deckId}/revisions/${made.revisionId}/file`)
      .buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="[a-z0-9-]+-v1\.pptx"$/);
    expect(file.headers['cache-control']).toBe('private, no-store');
    const zip = await JSZip.loadAsync(file.body as Buffer);
    expect(await zip.file('[Content_Types].xml')!.async('string')).toContain('presentationml');
    expect((await request(app).get(`${BASE}/${made.deckId}/revisions/irev-00000000-0000-0000-0000-000000000000/file`)).status).toBe(404);
    expect((await request(app).get(`${BASE}/not-a-deck`)).status).toBe(404);
  });
});

describe('initiative status deck — live drafter narrative', () => {
  type Call = { agentId: string; structuredInput: { tenant: string; mode: string; auth: { tenant: string }; slides: Array<{ slideId: string; evidence: Array<{ id: string; excerpt: string }> }> } };
  const narrativesFrom = (call: Call, bullet: string) => JSON.stringify({
    summary: 'Drafted.',
    narratives: call.structuredInput.slides.filter((s) => s.evidence[0]).map((s) => ({
      slideId: s.slideId, bullets: [bullet], source_spans: [{ evidenceId: s.evidence[0]!.id, text: s.evidence[0]!.excerpt.slice(0, 20) }],
    })),
  });
  async function withAgent(answer: (call: Call) => Promise<{ text: string; raw?: unknown }>): Promise<{ status: string; calls: Call[]; deck: { status: number; body: { narrative: { status: string; reason?: string } } } }> {
    const calls: Call[] = [];
    (config.mock as { agentcore: boolean }).agentcore = false;
    const spy = jest.spyOn(agentcore, 'invokeAgent').mockImplementation((async (agentId: string, opts: Call['structuredInput'] & { structuredInput: Call['structuredInput'] }) => {
      const call = { agentId, structuredInput: opts.structuredInput } as Call; calls.push(call); return answer(call);
    }) as never);
    try { const deck = await request(as('program-owner')).post(`${BASE}/projects/${PID}`).send({ narrative: true }); return { status: 'ok', calls, deck }; }
    finally { spy.mockRestore(); (config.mock as { agentcore: boolean }).agentcore = true; }
  }

  it('sends its own tenant and mode, and merges a grounded narrative', async () => {
    const r = await withAgent(async (call) => ({ text: narrativesFrom(call, 'Plain delivery prose.') }));
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.structuredInput).toMatchObject({ tenant: 'orgiq', mode: 'initiative-status-deck', auth: { tenant: 'orgiq' } });
    expect(r.deck.status).toBe(201);
    expect(['applied', 'partial']).toContain(r.deck.body.narrative.status);
  });

  it('a number the facts do not carry is refused: the template stays', async () => {
    const r = await withAgent(async (call) => ({ text: narrativesFrom(call, 'Invented figure 98765431 here.') }));
    expect(r.deck.status).toBe(201);
    expect(r.deck.body.narrative.status).toBe('fallback');
  });

  it('a refusal (403 envelope), a throw or an empty answer never fails the deck', async () => {
    for (const answer of [
      async () => ({ text: '', raw: { error: 'forbidden', detail: 'only serves another tenant' } }),
      async () => { throw new Error('runtime unreachable'); },
      async () => ({ text: ' ' }),
    ]) {
      const r = await withAgent(answer as never);
      expect(r.deck.status).toBe(201);
      expect(r.deck.body.narrative.status).toBe('unavailable');
    }
  });
});

describe('initiative status deck — agent revise', () => {
  const revise = (app: express.Express, id: string, body: Record<string, unknown>) => request(app).post(`${BASE}/${id}/revise`).send(body);

  it('a DispatchAgentRun role revises: one new active revision on the named base, producedBy the agent', async () => {
    const app = as('sme');
    const made = await build(app);
    const res = await revise(app, made.deckId, { instruction: 'Add speaker notes', baseRevisionId: made.revisionId });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ engine: 'offline', replayed: false });
    expect(res.body.revisionId).toMatch(/^irev-/);
    const detail = (await request(app).get(`${BASE}/${made.deckId}`)).body;
    expect(detail.activeRevisionId).toBe(res.body.revisionId);
    expect(detail.revisions).toHaveLength(2);
    expect(detail.revisions[0].producedBy).toBe('agent:orgiq');
  });

  it('a member (no DispatchAgentRun) is refused and nothing is written', async () => {
    const made = await build(as('sme'));
    expect((await revise(as('member'), made.deckId, { instruction: 'Shorter', baseRevisionId: made.revisionId })).status).toBe(403);
    expect(initiativeDeckRevisionsFixture.rows()).toHaveLength(1);
  });

  it('a stale base is 409 with the active revision; a locked or unknown slide and a bad body are refused', async () => {
    const app = as('org-leader');
    const made = await build(app);
    const first = await revise(app, made.deckId, { instruction: 'Add speaker notes', baseRevisionId: made.revisionId });
    expect(first.status).toBe(201);
    const stale = await revise(app, made.deckId, { instruction: 'Make it shorter', baseRevisionId: made.revisionId });
    expect(stale.status).toBe(409);
    expect(stale.body.activeRevisionId).toBe(first.body.revisionId);
    expect((await revise(app, made.deckId, { instruction: 'x', baseRevisionId: first.body.revisionId, slideId: 'nope' })).status).toBe(400);
    expect((await revise(app, made.deckId, { instruction: ' ', baseRevisionId: first.body.revisionId })).status).toBe(400);
    expect((await revise(app, made.deckId, { instruction: 'x', baseRevisionId: 'bad' })).status).toBe(400);
    expect((await revise(app, made.deckId, { instruction: 'x', baseRevisionId: first.body.revisionId, requestId: 'no' })).status).toBe(400);
    expect((await revise(app, 'idk-nope', { instruction: 'x', baseRevisionId: first.body.revisionId })).status).toBe(404);
  });

  it('the same requestId replays the first answer and writes nothing more', async () => {
    const app = as('sme');
    const made = await build(app);
    const body = { instruction: 'Add speaker notes', baseRevisionId: made.revisionId, requestId: 'req-0001-abcd' };
    const first = await revise(app, made.deckId, body);
    expect(first.status).toBe(201);
    const again = await revise(app, made.deckId, body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ revisionId: first.body.revisionId, replayed: true, summary: expect.any(String) });
    expect(initiativeDeckRevisionsFixture.rows()).toHaveLength(2);
    // A different request id on the now-stale base is a conflict, not a second write.
    expect((await revise(app, made.deckId, { ...body, requestId: 'req-0002-abcd' })).status).toBe(409);
  });

  it('a budget deck is not found to an SME, so it cannot be revised either', async () => {
    const leader = as('org-leader');
    const made = await build(leader);
    expect(made.includesBudget).toBe(true);
    expect((await revise(as('sme'), made.deckId, { instruction: 'Shorter', baseRevisionId: made.revisionId })).status).toBe(404);
  });
});
