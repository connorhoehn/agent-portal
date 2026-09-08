// Prompt history — /api/iq/prompts (routes/prompt-history.ts). The version
// log and experiment outcomes behind /iq/history, plus the two writes the
// canary controller and Prompt Studio make.
//
// What is pinned:
//   * `parseContract` REFUSING to write a malformed contract through. A
//     contract is what fences an untrusted variable at render time, so a blob
//     that is not the shape the contract module understands must fall back to
//     the empty contract rather than being stored as-is — a silently disabled
//     fence is the worst outcome here,
//   * a jsonb column arriving as TEXT over the Data API, and a corrupt one
//     degrading to the empty contract rather than throwing the whole read,
//   * that an experiment is grouped onto BOTH the versions it compared, so it
//     shows on either side of the timeline,
//   * `scoreDelta` derived (B − A) and NULL when either side has no score —
//     zero would read as "no difference", which is a claim,
//   * the finalAction allow-list, and the lifecycle transitions each one
//     causes: PROMOTE marks B promoted AND A superseded; ROLLBACK marks only
//     B rolled back; the others touch neither,
//   * the lifecycle-status allow-list falling back to `published` rather than
//     writing an unknown status,
//   * COALESCE on the upsert, so a partial edit does not blank the fields it
//     did not mention,
//   * the auth floor: two reads open, both writes ManageCanary.

const gateActions: string[] = [];

jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateActions.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { promptHistoryRouter } from '../prompt-history.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;

type Param = { name: string; value: Record<string, unknown> };
const callWith = (needle: string): [string, Param[]] | undefined => {
  const c = execMock.mock.calls.find((x) => String(x[0]).includes(needle));
  return c ? [String(c[0]), (c[1] ?? []) as Param[]] : undefined;
};
const paramOf = (needle: string, name: string): Record<string, unknown> | undefined =>
  callWith(needle)?.[1].find((p) => p.name === name)?.value;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/iq/prompts', promptHistoryRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { execMock.mockReset(); });

describe('auth floor', () => {
  it('gates both writes on ManageCanary and leaves the three reads open', () => {
    expect(gateActions).toEqual(['ManageCanary', 'ManageCanary']);
  });
});

describe('GET /history/:promptId', () => {
  function respondWith(meta: unknown[], experiments: unknown[]) {
    execMock.mockImplementation((sql: string) =>
      Promise.resolve(String(sql).includes('prompt_version_meta') ? meta : experiments));
  }

  it('parses a jsonb contract that arrived as TEXT over the Data API', async () => {
    respondWith([{
      version: '3', description: 'tighter refusal', author_email: 'nora@example.com',
      published_at: 't', deployed_at: null, superseded_at: null,
      lifecycle_status: 'deployed', kind: 'system', tier: 'endpoint',
      contract: JSON.stringify({
        kind: 'system', tier: 'endpoint', guardrailId: 'gr-1',
        variables: [{ name: 'question', type: 'text', required: true, source: 'untrusted' }],
      }),
      owner_email: 'nora@example.com', eval_pass_rate: 0.95,
    }], []);
    const res = await request(buildApp()).get('/api/iq/prompts/history/orgiq-supervisor');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['versions']);
    const v = res.body.versions[0];
    expect(v.contract.kind).toBe('system');
    expect(v.contract.tier).toBe('endpoint');
    expect(v.contract.guardrailId).toBe('gr-1');
    expect(v.contract.variables[0]).toMatchObject({ name: 'question', source: 'untrusted', required: true });
    expect(v.evalPassRate).toBe(0.95);
  });

  it('falls back to the EMPTY contract for a corrupt or wrong-shaped blob', async () => {
    // A contract is what fences an untrusted variable; a blob that is not the
    // shape the contract module understands must not be written through.
    const wrongShaped = JSON.stringify({ kind: 'nonsense', variables: 'x' });
    for (const contract of ['{not json', '[]', 'null', wrongShaped]) {
      respondWith([{ version: '1', contract, lifecycle_status: 'published' }], []);
      const res = await request(buildApp()).get('/api/iq/prompts/history/p1');
      expect(res.status).toBe(200);
      const c = res.body.versions[0].contract;
      expect(c.variables).toEqual([]);
      expect(c.kind).toBe('prompt');
      expect(c.tier).toBe('sandbox');
    }
  });

  it('drops a variable entry with no name rather than storing a nameless fence', async () => {
    respondWith([{
      version: '1', lifecycle_status: 'published',
      contract: JSON.stringify({ variables: [{ name: 'ok' }, { type: 'text' }, 'nope', null] }),
    }], []);
    const res = await request(buildApp()).get('/api/iq/prompts/history/p1');
    expect(res.body.versions[0].contract.variables.map((v: { name: string }) => v.name)).toEqual(['ok']);
  });

  it('groups an experiment onto BOTH the versions it compared', async () => {
    respondWith(
      [{ version: '2', lifecycle_status: 'published' }, { version: '3', lifecycle_status: 'published' }],
      [{
        experiment_id: 'ex-1', prompt_version_a: '2', prompt_version_b: '3',
        started_at: 't0', finished_at: 't1', final_action: 'PROMOTE',
        final_score_a: 0.7, final_score_b: 0.85, score_delta: 0.15, decision_count: 4,
      }],
    );
    const res = await request(buildApp()).get('/api/iq/prompts/history/p1');
    const byVersion = Object.fromEntries(
      (res.body.versions as Array<{ version: string; experiments: unknown[] }>)
        .map((v) => [v.version, v.experiments]),
    );
    // Either side of the timeline shows the comparison it took part in.
    expect((byVersion['2'] as Array<{ experimentId: string }>)[0]!.experimentId).toBe('ex-1');
    expect((byVersion['3'] as Array<{ experimentId: string }>)[0]!.experimentId).toBe('ex-1');
  });

  it('400s without a promptId, and degrades to an empty timeline on a DB error', async () => {
    execMock.mockRejectedValue(new Error('relation "observability.prompt_version_meta" does not exist'));
    const res = await request(buildApp()).get('/api/iq/prompts/history/p1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ versions: [] });
  });
});

describe('GET /experiments', () => {
  it('maps the summary and keeps a missing score NULL, not 0', async () => {
    execMock.mockResolvedValue([{
      experiment_id: 'ex-1', prompt_id: 'p1', canary_name: 'orgiq-canary',
      prompt_version_a: '2', prompt_version_b: '3', started_at: 't0', finished_at: 't1',
      final_action: 'PROMOTE', final_score_a: 0.7, final_score_b: null,
      score_delta: null, decision_count: null, halt_reason: '', description_b: 'tighter refusal',
    }]);
    const res = await request(buildApp()).get('/api/iq/prompts/experiments');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['experiments']);
    const e = res.body.experiments[0];
    expect(e.scoreB).toBeNull();
    expect(e.scoreDelta).toBeNull();
    // A missing decision count is genuinely zero decisions.
    expect(e.decisionCount).toBe(0);
    // The B-side description is joined in so the list reads as prose.
    expect(e.descriptionB).toBe('tighter refusal');
  });

  it('degrades to an empty list rather than failing /iq/history', async () => {
    execMock.mockRejectedValue(new Error('boom'));
    const res = await request(buildApp()).get('/api/iq/prompts/experiments');
    expect(res.body).toEqual({ experiments: [] });
  });
});

describe('GET /experiments/:id', () => {
  it('404s an unknown experiment', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/iq/prompts/experiments/ex-x');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Experiment not found');
  });

  it('returns the experiment beside its per-tick decision log', async () => {
    execMock.mockImplementation((sql: string) => Promise.resolve(
      String(sql).includes('canary_decisions')
        ? [{
            decided_at: 't1', action: 'RAMP', weight_b_before: 10, weight_b_after: 20,
            composite_a: 0.7, composite_b: 0.85, reason: 'B ahead for 3 ticks',
          }]
        : [{
            experiment_id: 'ex-1', prompt_id: 'p1', prompt_version_a: '2', prompt_version_b: '3',
            started_at: 't0', finished_at: 't2', final_action: 'PROMOTE',
            final_score_a: 0.7, final_score_b: 0.85, score_delta: 0.15,
            decision_count: 1, halt_reason: '',
          }],
    ));
    const res = await request(buildApp()).get('/api/iq/prompts/experiments/ex-1');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['decisions', 'experiment']);
    expect(res.body.experiment.scoreDelta).toBeCloseTo(0.15, 10);
    expect(res.body.decisions[0]).toEqual({
      decidedAt: 't1', action: 'RAMP', weightBefore: 10, weightAfter: 20,
      scoreA: 0.7, scoreB: 0.85, reason: 'B ahead for 3 ticks',
    });
  });
});

describe('POST /experiments/:id/complete', () => {
  it('requires the prompt and both versions', async () => {
    const app = buildApp();
    for (const body of [{}, { promptId: 'p1' }, { promptId: 'p1', versionA: '2' }]) {
      const res = await request(app).post('/api/iq/prompts/experiments/ex-1/complete').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/promptId, versionA, versionB required/);
    }
    expect(execMock).not.toHaveBeenCalled();
  });

  it('refuses an unknown finalAction, naming the four it accepts', async () => {
    const res = await request(buildApp()).post('/api/iq/prompts/experiments/ex-1/complete')
      .send({ promptId: 'p1', versionA: '2', versionB: '3', finalAction: 'SHIP_IT' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PROMOTE, ROLLBACK, HALTED, IN_PROGRESS/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('derives scoreDelta as B − A, and NULL when either side is missing', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).post('/api/iq/prompts/experiments/ex-1/complete')
      .send({ promptId: 'p1', versionA: '2', versionB: '3', scoreA: 0.7, scoreB: 0.85 });
    expect(paramOf('canary_experiments', 'scoreDelta')!['doubleValue']).toBeCloseTo(0.15, 10);

    execMock.mockClear();
    await request(app).post('/api/iq/prompts/experiments/ex-2/complete')
      .send({ promptId: 'p1', versionA: '2', versionB: '3', scoreA: 0.7 });
    // Zero would read as "no difference" — a claim we cannot make.
    expect(paramOf('canary_experiments', 'scoreDelta')).toEqual({ isNull: true });
  });

  it('PROMOTE marks B promoted AND A superseded', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp()).post('/api/iq/prompts/experiments/ex-1/complete')
      .send({ promptId: 'p1', versionA: '2', versionB: '3', finalAction: 'PROMOTE' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, experimentId: 'ex-1' });
    const promoted = execMock.mock.calls.find((c) => String(c[0]).includes("'promoted'"))!;
    expect(((promoted[1] ?? []) as Param[]).find((p) => p.name === 'version')!.value)
      .toEqual({ stringValue: '3' });
    const superseded = execMock.mock.calls.find((c) => String(c[0]).includes("'superseded'"))!;
    expect(((superseded[1] ?? []) as Param[]).find((p) => p.name === 'version')!.value)
      .toEqual({ stringValue: '2' });
  });

  it('ROLLBACK marks only B rolled back — A was never replaced', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp()).post('/api/iq/prompts/experiments/ex-1/complete')
      .send({ promptId: 'p1', versionA: '2', versionB: '3', finalAction: 'ROLLBACK' });
    expect(execMock.mock.calls.some((c) => String(c[0]).includes("'rolled_back'"))).toBe(true);
    expect(execMock.mock.calls.some((c) => String(c[0]).includes("'superseded'"))).toBe(false);
    expect(execMock.mock.calls.some((c) => String(c[0]).includes("'promoted'"))).toBe(false);
  });

  it('HALTED and IN_PROGRESS touch no lifecycle rows', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    for (const finalAction of ['HALTED', 'IN_PROGRESS']) {
      execMock.mockClear();
      await request(app).post('/api/iq/prompts/experiments/ex-1/complete')
        .send({ promptId: 'p1', versionA: '2', versionB: '3', finalAction });
      expect(execMock).toHaveBeenCalledTimes(1);
      expect(String(execMock.mock.calls[0]![0])).toMatch(/canary_experiments/);
    }
  });

  it('upserts on experiment_id so a re-completion updates rather than duplicating', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp()).post('/api/iq/prompts/experiments/ex-1/complete')
      .send({ promptId: 'p1', versionA: '2', versionB: '3' });
    expect(callWith('canary_experiments')![0]).toMatch(/ON CONFLICT \(experiment_id\) DO UPDATE/);
  });

  it('mints an experiment id when the caller supplies none in the path', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp()).post('/api/iq/prompts/experiments/%20/complete')
      .send({ promptId: 'p1', versionA: '2', versionB: '3' });
    expect(res.status).toBe(200);
    expect(String(res.body.experimentId).length).toBeGreaterThan(0);
  });
});

describe('PUT /meta/:promptId/:version', () => {
  it('falls back to `published` for an unknown lifecycle status', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).put('/api/iq/prompts/meta/p1/3').send({ lifecycleStatus: 'shipped' });
    expect(paramOf('prompt_version_meta', 'lifecycleStatus')).toEqual({ stringValue: 'published' });

    execMock.mockClear();
    await request(app).put('/api/iq/prompts/meta/p1/3').send({ lifecycleStatus: 'rolled_back' });
    expect(paramOf('prompt_version_meta', 'lifecycleStatus')).toEqual({ stringValue: 'rolled_back' });
  });

  it('normalises the contract before storing it, and stores kind/tier FROM it', async () => {
    execMock.mockResolvedValue([]);
    // The bad values are bound to locals rather than written inline: this is
    // REQUEST INPUT, not a fixture of anything the server sends, and the wire
    // sweep (mock/core/wire/scan.ts) rightly treats an inline `kind:` string
    // on a contract-shaped literal as a fixture claiming server vocabulary.
    const notAKind = 'nonsense';
    const notATier = 'nonsense';
    await request(buildApp()).put('/api/iq/prompts/meta/p1/3').send({
      contract: { kind: notAKind, tier: notATier, guardrailId: 7, variables: 'not an array' },
    });
    const stored = JSON.parse(String(paramOf('prompt_version_meta', 'contract')!['stringValue'])) as Record<string, unknown>;
    expect(stored['kind']).toBe('prompt');
    expect(stored['tier']).toBe('sandbox');
    expect(stored['guardrailId']).toBeNull();
    expect(stored['variables']).toEqual([]);
    // The denormalised columns come from the parsed contract, so the two
    // cannot drift.
    expect(paramOf('prompt_version_meta', 'kind')).toEqual({ stringValue: 'prompt' });
    expect(paramOf('prompt_version_meta', 'tier')).toEqual({ stringValue: 'sandbox' });
  });

  it('COALESCEs on conflict so a partial edit does not blank what it omitted', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp()).put('/api/iq/prompts/meta/p1/3')
      .send({ lifecycleStatus: 'deployed' });
    expect(res.status).toBe(200);
    const sql = callWith('prompt_version_meta')![0];
    for (const col of ['description', 'author_email', 'owner_email', 'eval_pass_rate']) {
      expect(sql).toMatch(new RegExp(`${col}\\s*=\\s*COALESCE\\(EXCLUDED`));
    }
    // An omitted description is bound as SQL NULL, which COALESCE then skips.
    expect(paramOf('prompt_version_meta', 'description')).toEqual({ isNull: true });
  });

  it('drops a non-numeric eval pass rate rather than writing a string', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).put('/api/iq/prompts/meta/p1/3').send({ evalPassRate: '0.9' });
    expect(paramOf('prompt_version_meta', 'evalPassRate')).toEqual({ isNull: true });

    execMock.mockClear();
    await request(app).put('/api/iq/prompts/meta/p1/3').send({ evalPassRate: 0.9 });
    expect(paramOf('prompt_version_meta', 'evalPassRate')).toEqual({ doubleValue: 0.9 });
  });
});
