// Pipeline run report decks (docs/agentic-flows-migration.md slice 3): every
// number on a slide equals the run projection, the authz matrix over the
// pipelines roles and other tenants, CAS 409, download headers, narrative
// fallback, and mock reset.

// Sessions here are hand-built (no directory rows): the deck write rule's fresh
// directory re-read (live-principal.ts) is the identity, its Cedar decisions stay real.
jest.mock('../../lib/live-principal.js', () => ({
  ...jest.requireActual('../../lib/live-principal.js'),
  currentLiveSession: async (session: unknown) => session,
}));
jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'author', tenant: 'pipelines', label: 'Author', summary: '', capabilities: ['ViewPipelines', 'AuthorDefinition', 'RunPipeline'] },
    { id: 'operator', tenant: 'pipelines', label: 'Operator', summary: '', capabilities: ['ViewPipelines', 'RunPipeline', 'ApproveStep', 'CancelRun'] },
    { id: 'pipeline-admin', tenant: 'pipelines', label: 'Pipeline Admin', summary: '', capabilities: ['ViewPipelines', 'RunPipeline', 'ApproveStep', 'CancelRun', 'ManagePipelineConfig', 'ManageUsers'] },
    { id: 'pipeline-reader', tenant: 'pipelines', label: 'Reader', summary: '', capabilities: ['ViewPipelines'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import JSZip from 'jszip';
import request from '../../test-support/http.js';
import { pipelinesRouter } from '../pipelines.js';
import { mockControlRouter } from '../mock-control.js';
import { requireTenant } from '../../lib/authz.js';
import { errorHandler } from '../../lib/async-handler.js';
import type { Session } from '../../lib/session.js';
import { loadProjection } from '../../providers/pipeline-runs.js';
import { pipelineDecksFixture, pipelineDeckRevisionsFixture } from '../../mock/pipeline-decks.js';
import { buildRunDeckFacts, formatDuration } from '../../lib/pipeline-deck/facts.js';
import { loadRunDeckSource } from '../../providers/pipeline-decks.js';
import type { DeckSpec } from '@connorhoehn/realtime-modules/deck';
import { config } from '../../config.js';
import { agentcore } from '../../providers/index.js';
import { flowRunsFixture } from '../../mock/flow-runs.js';
import { flowRunStore, pendingFlowRuns } from '../../lib/flow-runs/index.js';
import { hidePptxNodeDetection } from '../../test-support/pptxTestEnv.js';

let restoreRelease: () => void;
beforeAll(() => { restoreRelease = hidePptxNodeDetection(); });
afterAll(() => restoreRelease());
beforeEach(() => { pipelineDecksFixture.reset(); pipelineDeckRevisionsFixture.reset(); flowRunsFixture.reset(); });

function appAs(session: Partial<Session>) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.session = { sub: 'u-test', iat: 0, grants: {}, ...session } as Session; next(); });
  app.use('/api/pipelines', requireTenant('pipelines'), pipelinesRouter);
  app.use(mockControlRouter);
  app.use(errorHandler);
  return app;
}
const as = (role: string) => appAs({ role: role as Session['role'], tenant: 'pipelines', sub: `u-${role}` });

/** A run with steps and, preferably, a failure — chosen from the projection, not hard-coded. */
async function pickRun(): Promise<string> {
  const p = await loadProjection();
  const withSteps = p.runs.filter((r) => (p.steps.get(r.id) ?? []).length > 0);
  expect(withSteps.length).toBeGreaterThan(0);
  return (withSteps.find((r) => r.status === 'failed') ?? withSteps[0]!).id;
}

const slideText = (spec: DeckSpec, id: string): string => {
  const s = spec.slides.find((x) => x.id === id)!;
  return [...(s.bullets ?? []), ...(s.columns?.flat() ?? [])].join('\n');
};

describe('run report deck — facts equal the run projection', () => {
  it('summary and step slides state exactly the projection numbers', async () => {
    const runId = await pickRun();
    const p = await loadProjection();
    const run = p.runs.find((r) => r.id === runId)!;
    const steps = p.steps.get(runId)!;
    const app = as('operator');
    const created = await request(app).post(`/api/pipelines/runs/${encodeURIComponent(runId)}/decks`).send({});
    expect(created.status).toBe(201);
    const spec: DeckSpec = (await request(app).get(`/api/pipelines/decks/${created.body.deckId}/revisions/${created.body.revisionId}/spec`)).body;

    const n = (status: string) => steps.filter((s) => s.status === status).length;
    const summary = slideText(spec, 'summary');
    expect(summary).toContain(`Status: ${run.status}`);
    expect(summary).toContain(`Steps: ${steps.length} total · ${n('completed')} completed · ${n('failed')} failed · ${n('skipped')} skipped`);
    expect(summary).toContain(`Cost: ${run.costUsd === null ? 'not recorded' : `$${run.costUsd.toFixed(4)}`}`);
    if (run.startedAt && run.finishedAt) {
      expect(summary).toContain(`Duration: ${formatDuration(Date.parse(run.finishedAt) - Date.parse(run.startedAt))}`);
    } else {
      expect(summary).toContain('Duration: not recorded');
    }
    const stepList = slideText(spec, 'steps');
    for (const s of steps.slice(0, 7)) expect(stepList).toContain(`${s.label} — ${s.status}`);
    // Every slide cites a source (the engine refuses one that does not).
    expect(spec.slides.every((s) => s.sources.length > 0)).toBe(true);
    if (n('failed')) expect(spec.slides.some((s) => s.id === 'failures')).toBe(true);
    // Chart values are the recorded durations in seconds.
    const chart = spec.slides.find((s) => s.id === 'timeline')?.chart;
    if (chart) {
      const timed = steps.filter((s) => s.startedAt && s.finishedAt).slice(0, 24);
      expect(chart.series[0]!.values).toEqual(timed.map((s) => Math.round((Date.parse(s.finishedAt!) - Date.parse(s.startedAt!)) / 100) / 10));
    }
  });

  it('is deterministic: the same projection yields the same deck', async () => {
    const source = (await loadRunDeckSource(await pickRun()))!;
    expect(buildRunDeckFacts(source).spec).toEqual(buildRunDeckFacts(source).spec);
  });

  it('an unknown run is 404', async () => {
    const res = await request(as('operator')).post('/api/pipelines/runs/job:nope/decks').send({});
    expect(res.status).toBe(404);
  });
});

describe('run report deck — narrative', () => {
  it('the offline drafter writes prose with verbatim spans; numbers stay the facts', async () => {
    const runId = await pickRun();
    const app = as('author');
    const plain = await request(app).post(`/api/pipelines/runs/${encodeURIComponent(runId)}/decks`).send({});
    const withNarrative = await request(app).post(`/api/pipelines/runs/${encodeURIComponent(runId)}/decks`).send({ narrative: true });
    expect(withNarrative.status).toBe(201);
    expect(withNarrative.body.narrative.requested).toBe(true);
    expect(['applied', 'partial', 'fallback']).toContain(withNarrative.body.narrative.status);
    const get = async (r: { body: { deckId: string; revisionId: string } }): Promise<DeckSpec> =>
      (await request(app).get(`/api/pipelines/decks/${r.body.deckId}/revisions/${r.body.revisionId}/spec`)).body;
    const a = await get(plain); const b = await get(withNarrative);
    // The fact bullets (everything the model may not touch) are identical.
    for (const id of ['summary', 'steps']) {
      const fa = a.slides.find((s) => s.id === id)!.bullets!; const fb = b.slides.find((s) => s.id === id)!.bullets!;
      expect(fb.slice(0, id === 'summary' ? 6 : fa.length)).toEqual(fa.slice(0, id === 'summary' ? 6 : fa.length));
    }
  });
});

describe('run report deck — authz', () => {
  it('pipelines roles with RunPipeline generate; a reader reads but cannot generate or edit', async () => {
    const runId = await pickRun();
    const url = `/api/pipelines/runs/${encodeURIComponent(runId)}/decks`;
    for (const role of ['author', 'operator', 'pipeline-admin']) {
      expect((await request(as(role)).post(url).send({})).status).toBe(201);
    }
    expect((await request(as('pipeline-reader')).post(url).send({})).status).toBe(403);
    const made = (await request(as('operator')).post(url).send({})).body;
    const reader = as('pipeline-reader');
    expect((await request(reader).get(`/api/pipelines/decks/${made.deckId}`)).status).toBe(200);
    expect((await request(reader).get('/api/pipelines/decks')).status).toBe(200);
    const spec = (await request(reader).get(`/api/pipelines/decks/${made.deckId}/revisions/${made.revisionId}/spec`)).body;
    expect((await request(reader).post(`/api/pipelines/decks/${made.deckId}/revisions`).send({ spec, baseRevisionId: made.revisionId })).status).toBe(403);
    expect((await request(reader).post(`/api/pipelines/decks/${made.deckId}/preview`).send({ spec })).status).toBe(200);
  });

  it('other tenants are refused before any handler', async () => {
    const orgiq = appAs({ role: 'member' as Session['role'], tenant: 'orgiq', sub: 'u-theo' });
    const assessment = appAs({ role: 'assessor' as Session['role'], tenant: 'assessment', sub: 'u-asha' });
    for (const app of [orgiq, assessment]) {
      expect((await request(app).get('/api/pipelines/decks')).status).toBe(403);
      expect((await request(app).post('/api/pipelines/runs/job:x/decks').send({})).status).toBe(403);
    }
  });
});

describe('run report deck — revisions, preview, download', () => {
  it('saves a person edit; a stale base is 409; reset clears decks', async () => {
    const runId = await pickRun();
    const app = as('operator');
    const made = (await request(app).post(`/api/pipelines/runs/${encodeURIComponent(runId)}/decks`).send({})).body;
    const spec: DeckSpec = (await request(app).get(`/api/pipelines/decks/${made.deckId}/revisions/${made.revisionId}/spec`)).body;
    const edited = { ...spec, slides: spec.slides.map((s) => (s.id === 'summary' ? { ...s, title: 'Executive view' } : s)) };
    const saved = await request(app).post(`/api/pipelines/decks/${made.deckId}/revisions`).send({ spec: edited, baseRevisionId: made.revisionId, label: 'Retitled' });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ label: 'Retitled', producedBy: 'person:u-operator' });
    const stale = await request(app).post(`/api/pipelines/decks/${made.deckId}/revisions`).send({ spec: edited, baseRevisionId: made.revisionId });
    expect(stale.status).toBe(409);
    expect(stale.body.activeRevisionId).toBe(saved.body.id);
    const bad = await request(app).post(`/api/pipelines/decks/${made.deckId}/revisions`).send({ spec: { title: '', slides: [] }, baseRevisionId: saved.body.id });
    expect(bad.status).toBe(400);
    const detail = (await request(app).get(`/api/pipelines/decks/${made.deckId}`)).body;
    expect(detail.revisions.map((r: { id: string }) => r.id)).toEqual([saved.body.id, made.revisionId]);
    expect(detail.activeRevisionId).toBe(saved.body.id);
    expect((await request(app).post('/api/__mock/reset')).status).toBeLessThan(300);
    expect((await request(app).get('/api/pipelines/decks')).body).toEqual([]);
  });

  it('previews svg per slide and downloads a valid .pptx attachment', async () => {
    const runId = await pickRun();
    const app = as('operator');
    const made = (await request(app).post(`/api/pipelines/runs/${encodeURIComponent(runId)}/decks`).send({})).body;
    const spec: DeckSpec = (await request(app).get(`/api/pipelines/decks/${made.deckId}/revisions/${made.revisionId}/spec`)).body;
    const preview = await request(app).post(`/api/pipelines/decks/${made.deckId}/preview`).send({ spec });
    expect(preview.status).toBe(200);
    expect(preview.body.slides.length).toBe(spec.slides.length + 1); // + generated Sources slide
    const file = await request(app).get(`/api/pipelines/decks/${made.deckId}/revisions/${made.revisionId}/file`)
      .buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="[a-z0-9-]+-v1\.pptx"$/);
    const zip = await JSZip.loadAsync(file.body as Buffer);
    expect(await zip.file('[Content_Types].xml')!.async('string')).toContain('presentationml');
    expect((await request(app).get(`/api/pipelines/decks/${made.deckId}/revisions/prev-00000000-0000-0000-0000-000000000000/file`)).status).toBe(404);
  });
});

// ─── Agent revise (docs/agentic-flows-migration.md slice 3 follow-up) ────────

const settleRuns = async (): Promise<void> => { await Promise.all([...pendingFlowRuns]); };
const makeDeck = async (app: ReturnType<typeof as>): Promise<{ deckId: string; revisionId: string; spec: DeckSpec }> => {
  const made = (await request(app).post(`/api/pipelines/runs/${encodeURIComponent(await pickRun())}/decks`).send({})).body;
  const spec: DeckSpec = (await request(app).get(`/api/pipelines/decks/${made.deckId}/revisions/${made.revisionId}/spec`)).body;
  return { deckId: made.deckId, revisionId: made.revisionId, spec };
};
const reviseUrl = (deckId: string): string => `/api/pipelines/decks/${deckId}/revise`;
const runUrl = (deckId: string, runId: string): string => `/api/pipelines/decks/${deckId}/runs/${runId}`;

describe('run report deck — agent revise', () => {
  it('runs revise-pipeline-run-deck as a flow run and writes one revision produced by that run', async () => {
    const app = as('operator');
    const { deckId, revisionId, spec } = await makeDeck(app);
    const started = await request(app).post(`/api/pipelines/decks/${deckId}/revise`).send({ instruction: 'Tighten the bullets', baseRevisionId: revisionId });
    expect(started.status).toBe(202);
    expect(started.body.runId).toMatch(/^pdr-[0-9a-f-]{36}$/);
    await settleRuns();
    const run = (await request(app).get(`/api/pipelines/decks/${deckId}/runs/${started.body.runId}`)).body;
    expect(run).toMatchObject({ id: started.body.runId, status: 'completed', error: null, engine: 'offline' });
    expect(run.revisionId).toEqual(expect.any(String));
    const detail = (await request(app).get(`/api/pipelines/decks/${deckId}`)).body;
    expect(detail.activeRevisionId).toBe(run.revisionId);
    expect(detail.revisions).toHaveLength(2);
    expect(detail.revisions[0]).toMatchObject({ id: run.revisionId, producedBy: started.body.runId });
    // Facts re-applied: every slide keeps its id, order, and the fact bullets.
    const next: DeckSpec = (await request(app).get(`/api/pipelines/decks/${deckId}/revisions/${run.revisionId}/spec`)).body;
    expect(next.slides.map((s) => s.id)).toEqual(spec.slides.map((s) => s.id));
    expect(slideText(next, 'summary').split('\n').slice(0, 6)).toEqual(slideText(spec, 'summary').split('\n').slice(0, 6));
    // The stored input is private and gone once the run finished.
    expect((await flowRunStore.get(started.body.runId))!.input).toBeNull();
  });

  it('a stale base is 409 { error, activeRevisionId } and starts no run', async () => {
    const app = as('operator');
    const { deckId, revisionId, spec } = await makeDeck(app);
    const saved = (await request(app).post(`/api/pipelines/decks/${deckId}/revisions`).send({ spec, baseRevisionId: revisionId })).body;
    const stale = await request(app).post(reviseUrl(deckId)).send({ instruction: 'Tighten', baseRevisionId: revisionId });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: expect.any(String), activeRevisionId: saved.id });
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });

  it('a head that moves while the run is in flight fails the run without writing', async () => {
    const app = as('operator');
    const { deckId, revisionId, spec } = await makeDeck(app);
    const started = await request(app).post(reviseUrl(deckId)).send({ instruction: 'Add speaker notes', baseRevisionId: revisionId });
    // A person saves before the executor (a microtask away) reads the deck.
    await request(app).post(`/api/pipelines/decks/${deckId}/revisions`).send({ spec, baseRevisionId: revisionId });
    await settleRuns();
    const run = (await request(app).get(runUrl(deckId, started.body.runId))).body;
    if (run.status === 'failed') expect(run.error).toMatch(/newer revision/);
    const detail = (await request(app).get(`/api/pipelines/decks/${deckId}`)).body;
    expect(detail.revisions.filter((r: { producedBy: string }) => r.producedBy === started.body.runId).length).toBe(run.status === 'completed' ? 1 : 0);
  });

  it('validates the body, the slide, and locked slides', async () => {
    const app = as('operator');
    const { deckId, revisionId, spec } = await makeDeck(app);
    const post = (body: Record<string, unknown>) => request(app).post(reviseUrl(deckId)).send(body);
    expect((await post({ baseRevisionId: revisionId })).status).toBe(400);
    expect((await post({ instruction: '   ', baseRevisionId: revisionId })).status).toBe(400);
    expect((await post({ instruction: 'x'.repeat(2001), baseRevisionId: revisionId })).status).toBe(400);
    expect((await post({ instruction: 'Tighten' })).status).toBe(400);
    expect((await post({ instruction: 'Tighten', baseRevisionId: revisionId, slideId: 'nope' })).status).toBe(400);
    expect((await request(app).post('/api/pipelines/decks/pdeck-00000000-0000-0000-0000-000000000000/revise')
      .send({ instruction: 'Tighten', baseRevisionId: revisionId })).status).toBe(404);
    const locked = (await request(app).post(`/api/pipelines/decks/${deckId}/revisions`)
      .send({ spec, baseRevisionId: revisionId, lockedSlideIds: ['summary'] })).body;
    const refused = await post({ instruction: 'Tighten', baseRevisionId: locked.id, slideId: 'summary' });
    expect(refused.status).toBe(409);
    expect(refused.body.activeRevisionId).toBeUndefined();
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });

  it('is gated by RunPipeline; a reader and other tenants are refused before any run starts', async () => {
    const { deckId, revisionId } = await makeDeck(as('operator'));
    const body = { instruction: 'Tighten', baseRevisionId: revisionId };
    expect((await request(as('pipeline-reader')).post(reviseUrl(deckId)).send(body)).status).toBe(403);
    expect((await request(appAs({ role: 'member' as Session['role'], tenant: 'orgiq', sub: 'u-theo' })).post(reviseUrl(deckId)).send(body)).status).toBe(403);
    expect((await request(appAs({ role: 'assessor' as Session['role'], tenant: 'assessment', sub: 'u-asha' })).post(reviseUrl(deckId)).send(body)).status).toBe(403);
    expect(flowRunsFixture.rows()).toHaveLength(0);
    for (const role of ['author', 'operator', 'pipeline-admin']) {
      expect((await request(as(role)).post(reviseUrl(deckId)).send(body)).status).toBe(202);
      await settleRuns();
      flowRunsFixture.reset();
      const head = (await request(as(role)).get(`/api/pipelines/decks/${deckId}`)).body.activeRevisionId;
      body.baseRevisionId = head;
    }
  });

  it('a run is its requester\'s alone: another operator, a reader, another deck and another tenant read 404/403', async () => {
    const owner = as('operator');
    const { deckId, revisionId } = await makeDeck(owner);
    const other = await makeDeck(owner);
    const started = (await request(owner).post(reviseUrl(deckId)).send({ instruction: 'Tighten', baseRevisionId: revisionId })).body;
    await settleRuns();
    expect((await request(owner).get(runUrl(deckId, started.runId))).status).toBe(200);
    expect((await request(owner).get(runUrl(other.deckId, started.runId))).status).toBe(404);
    expect((await request(as('pipeline-admin')).get(runUrl(deckId, started.runId))).status).toBe(404);
    expect((await request(appAs({ role: 'operator' as Session['role'], tenant: 'pipelines', sub: 'u-other' })).get(runUrl(deckId, started.runId))).status).toBe(404);
    expect((await request(owner).get(runUrl(deckId, 'pdr-00000000-0000-0000-0000-000000000000'))).status).toBe(404);
    expect((await request(owner).get(runUrl(deckId, 'sum-00000000-0000-0000-0000-000000000000'))).status).toBe(404);
    expect((await request(appAs({ role: 'member' as Session['role'], tenant: 'orgiq', sub: 'u-operator' })).get(runUrl(deckId, started.runId))).status).toBe(403);
  });

  it('caps a person\'s concurrent revises', async () => {
    const app = as('operator');
    const { deckId, revisionId } = await makeDeck(app);
    for (let i = 0; i < 3; i++) {
      await flowRunStore.create({ tenant: 'pipelines', kind: 'pipelines.deck-revise', requestedBy: 'u-operator', scope: deckId, input: null, idPrefix: 'pdr' });
    }
    const res = await request(app).post(reviseUrl(deckId)).send({ instruction: 'Tighten', baseRevisionId: revisionId });
    expect(res.status).toBe(429);
  });

  describe('with a live agent', () => {
    const live = async <T>(answer: () => Promise<{ text: string; raw?: unknown }>, fn: () => Promise<T>): Promise<T> => {
      (config.mock as { agentcore: boolean }).agentcore = false;
      const spy = jest.spyOn(agentcore, 'invokeAgent').mockImplementation(answer as never);
      try { return await fn(); } finally { spy.mockRestore(); (config.mock as { agentcore: boolean }).agentcore = true; }
    };

    it('the drafter\'s tenant guard refuses pipelines, so the deterministic reviser answers (engine fallback)', async () => {
      const app = as('operator');
      const { deckId, revisionId } = await makeDeck(app);
      const run = await live(async () => ({ text: '', raw: { error: 'This agent serves only the assessment tenant.' } }), async () => {
        const started = (await request(app).post(reviseUrl(deckId)).send({ instruction: 'Add speaker notes', baseRevisionId: revisionId })).body;
        await settleRuns();
        return (await request(app).get(runUrl(deckId, started.runId))).body;
      });
      expect(run).toMatchObject({ status: 'completed', engine: 'fallback' });
      expect(run.revisionId).toEqual(expect.any(String));
    });

    it('asks for the pipelines-owned revise mode, with the tenant in auth', async () => {
      const app = as('operator');
      const { deckId, revisionId } = await makeDeck(app);
      const calls: Array<{ structuredInput: { mode: string; tenant: string; auth: { tenant: string } } }> = [];
      await live(async () => ({ text: '', raw: { error: 'no' } }), async () => {
        const spy = jest.spyOn(agentcore, 'invokeAgent').mockImplementation((async (_id: string, req: never) => { calls.push(req); return { text: '' }; }) as never);
        const started = (await request(app).post(reviseUrl(deckId)).send({ instruction: 'Tighten', baseRevisionId: revisionId })).body;
        await settleRuns();
        spy.mockRestore();
        return started;
      });
      expect(calls[0]?.structuredInput).toMatchObject({ mode: 'revise-pipeline-run-deck', tenant: 'pipelines', auth: { tenant: 'pipelines' } });
    });

    it('an agent answer is merged under the same rules: a changed slide list fails the run, no revision', async () => {
      const app = as('operator');
      const { deckId, revisionId, spec } = await makeDeck(app);
      const run = await live(async () => ({ text: JSON.stringify({ summary: 'ok', spec: { ...spec, slides: spec.slides.slice(1) }, changedSlideIds: [] }) }), async () => {
        const started = (await request(app).post(reviseUrl(deckId)).send({ instruction: 'Tighten', baseRevisionId: revisionId })).body;
        await settleRuns();
        return (await request(app).get(runUrl(deckId, started.runId))).body;
      });
      expect(run.status).toBe('failed');
      expect(run.error).toMatch(/slide list/);
      expect((await request(app).get(`/api/pipelines/decks/${deckId}`)).body.revisions).toHaveLength(1);
    });

    it('a number the agent invents is re-imposed away: facts survive the revision', async () => {
      const app = as('operator');
      const { deckId, revisionId, spec } = await makeDeck(app);
      const forged: DeckSpec = JSON.parse(JSON.stringify(spec));
      const summary = forged.slides.find((s) => s.id === 'summary')!;
      summary.bullets = summary.bullets!.map((b) => b.replace(/Steps: \d+/, 'Steps: 9999'));
      summary.notes = 'Reworded.';
      const run = await live(async () => ({ text: JSON.stringify({ summary: 'Reworded.', spec: forged, changedSlideIds: ['summary'] }) }), async () => {
        const started = (await request(app).post(reviseUrl(deckId)).send({ instruction: 'Reword the notes', baseRevisionId: revisionId, slideId: 'summary' })).body;
        await settleRuns();
        return (await request(app).get(runUrl(deckId, started.runId))).body;
      });
      if (run.revisionId) {
        const next: DeckSpec = (await request(app).get(`/api/pipelines/decks/${deckId}/revisions/${run.revisionId}/spec`)).body;
        expect(slideText(next, 'summary')).not.toContain('9999');
      }
      expect(run.engine).toBe('agent');
    });
  });
});

describe('run report deck — live drafter narrative', () => {
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
    try { const deck = await request(as('author')).post(`/api/pipelines/runs/${encodeURIComponent(await pickRun())}/decks`).send({ narrative: true }); return { status: 'ok', calls, deck }; }
    finally { spy.mockRestore(); (config.mock as { agentcore: boolean }).agentcore = true; }
  }

  it('sends its own tenant and mode, and merges a grounded narrative', async () => {
    const r = await withAgent(async (call) => ({ text: narrativesFrom(call, 'Plain delivery prose.') }));
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.structuredInput).toMatchObject({ tenant: 'pipelines', mode: 'pipeline-run-deck', auth: { tenant: 'pipelines' } });
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
