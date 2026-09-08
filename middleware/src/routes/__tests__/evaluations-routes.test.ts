// Evaluations — /api/observability/evaluations (routes/evaluations.ts).
// Backs /iq/evaluations. The config is not cosmetic: canary-judge.ts reads it
// on every canary ask, so the enable toggle, model, rubric weights and sample
// rate change live judging behaviour.
//
// What is pinned:
//   * the auth floor — the config READ is open, the config WRITE is
//     ManageCanary (writing it changes live scoring for everyone),
//   * that the write returns the PERSISTED config, not the request body: the
//     page re-renders from the response, so echoing an unvalidated body would
//     show a setting that was never stored,
//   * `/recent` filters the broker's replay buffer to judge_score events and
//     returns them NEWEST FIRST — the page reads the head of the list,
//   * the limit clamp (1..200, default 50, junk falls back), and that the
//     limit takes the LAST N events rather than the first.

const gateCalls: string[] = [];

jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateCalls.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
jest.mock('../../lib/judge-config.js', () => ({
  getJudgeConfig: jest.fn(),
  setJudgeConfig: jest.fn(),
}));
jest.mock('../../lib/canary-broker.js', () => ({ canaryBroker: { replay: jest.fn() } }));

import express from 'express';
import request from '../../test-support/http.js';
import { evaluationsRouter } from '../evaluations.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getJudgeConfig, setJudgeConfig } from '../../lib/judge-config.js';
import { canaryBroker } from '../../lib/canary-broker.js';

const getMock = getJudgeConfig as unknown as jest.Mock;
const setMock = setJudgeConfig as unknown as jest.Mock;
const replayMock = (canaryBroker as unknown as { replay: jest.Mock }).replay;

const CONFIG = {
  enabled: true, model: 'amazon.nova-pro-v1:0', sampleRate: 0.25,
  weights: { grounding: 0.5, completeness: 0.3, tone: 0.2 },
};

function judgeEvent(n: number) {
  return { type: 'judge_score', id: `js-${n}`, score: n / 10, at: `2026-08-20T09:0${n}:00Z` };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/observability/evaluations', evaluationsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { getMock.mockReset(); setMock.mockReset(); replayMock.mockReset(); });

describe('auth floor', () => {
  it('gates the config WRITE on ManageCanary and leaves both reads open', () => {
    expect(gateCalls).toEqual(['ManageCanary']);
  });
});

describe('GET /config', () => {
  it('serves the SSM-backed judge config as the page renders it', async () => {
    getMock.mockResolvedValue(CONFIG);
    const res = await request(buildApp()).get('/api/observability/evaluations/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(CONFIG);
    expect(res.body.weights.grounding).toBe(0.5);
  });
});

describe('PUT /config', () => {
  it('returns the PERSISTED config, not the body it was handed', async () => {
    // setJudgeConfig normalises/validates; the page re-renders from this
    // response, so echoing the raw body would display a value never stored.
    setMock.mockResolvedValue({ ...CONFIG, sampleRate: 1 });
    const res = await request(buildApp())
      .put('/api/observability/evaluations/config')
      .send({ ...CONFIG, sampleRate: 99 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, config: { ...CONFIG, sampleRate: 1 } });
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 99 }));
  });

  it('lets a validation failure surface as a 400 rather than a silent no-op', async () => {
    const { ValidationError } = jest.requireActual<typeof import('../../lib/async-handler.js')>(
      '../../lib/async-handler.js',
    );
    setMock.mockRejectedValue(new ValidationError('sampleRate must be between 0 and 1'));
    const res = await request(buildApp())
      .put('/api/observability/evaluations/config').send({ sampleRate: 99 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sampleRate/);
  });
});

describe('GET /recent', () => {
  it('keeps only judge_score events and hands them back newest first', async () => {
    replayMock.mockReturnValue([
      judgeEvent(1),
      { type: 'canary_ask', id: 'ask-1' },
      judgeEvent(2),
      { type: 'weight_change', id: 'w-1' },
      judgeEvent(3),
    ]);
    const res = await request(buildApp()).get('/api/observability/evaluations/recent');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['scores']);
    expect(res.body.scores.map((s: { id: string }) => s.id)).toEqual(['js-3', 'js-2', 'js-1']);
  });

  it('takes the LAST N judge events, not the first N', async () => {
    replayMock.mockReturnValue([judgeEvent(1), judgeEvent(2), judgeEvent(3)]);
    const res = await request(buildApp()).get('/api/observability/evaluations/recent?limit=2');
    expect(res.body.scores.map((s: { id: string }) => s.id)).toEqual(['js-3', 'js-2']);
  });

  it('clamps the limit into 1..200 and falls back to 50 on junk', async () => {
    const many = Array.from({ length: 300 }, (_, i) => judgeEvent(i));
    replayMock.mockReturnValue(many);
    const app = buildApp();
    const base = '/api/observability/evaluations/recent';
    expect((await request(app).get(base)).body.scores).toHaveLength(50);
    expect((await request(app).get('/api/observability/evaluations/recent?limit=9999')).body.scores).toHaveLength(200);
    expect((await request(app).get('/api/observability/evaluations/recent?limit=0')).body.scores).toHaveLength(1);
    expect((await request(app).get('/api/observability/evaluations/recent?limit=abc')).body.scores).toHaveLength(50);
  });

  it('returns an empty list when the replay buffer holds no judge events', async () => {
    replayMock.mockReturnValue([{ type: 'canary_ask', id: 'ask-1' }]);
    const res = await request(buildApp()).get('/api/observability/evaluations/recent');
    expect(res.body).toEqual({ scores: [] });
  });
});
