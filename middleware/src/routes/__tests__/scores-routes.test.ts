// The /api/scores surface (routes/scores.ts) — everything the Scores pages
// and the person drawer read. What is pinned here:
//
//   * the wire SHAPE the portal consumes (`entries`/`total`/`mostRecentScoredAt`
//     on a leaderboard, the RadarAxes envelope, the `{personId, samples,
//     deltaVs7d}` history contract) — spelled from the response, not from a
//     fixture typed from memory (contract.ts bug class 2),
//   * the ROUTE ORDER that makes `/radar` and `/:personId/radar` distinct —
//     the comment in the router says the batch route must be mounted first,
//     and nothing enforced it,
//   * the 400 validation branches (`by-skill` with no skill, `radar` with no
//     ids / more than four), the 404 branches, and the two graceful-degrade
//     branches (history swallows a provider throw, analysis 503s).
//
// Providers are mocked, so no Data API call and no Code Interpreter session.

jest.mock('../../providers/index.js', () => ({
  aurora: {
    getLeaderboard: jest.fn(),
    getTopSkills: jest.fn(),
    getSkillLeaderboard: jest.fn(),
    getCohorts: jest.fn(),
    getRadarBatch: jest.fn(),
    getPersonRadar: jest.fn(),
    getContributions: jest.fn(),
    getScore: jest.fn(),
  },
}));
jest.mock('../../providers/scores-history.js', () => ({ getPersonHistory: jest.fn() }));
jest.mock('../../lib/score-analysis.js', () => ({ analyzeScores: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { scoresRouter } from '../scores.js';
import { errorHandler } from '../../lib/async-handler.js';
import { aurora } from '../../providers/index.js';
import { getPersonHistory } from '../../providers/scores-history.js';
import { analyzeScores } from '../../lib/score-analysis.js';

const a = aurora as unknown as Record<string, jest.Mock>;
const historyMock = getPersonHistory as unknown as jest.Mock;
const analyzeMock = analyzeScores as unknown as jest.Mock;

const ENTRY = {
  personId: 'p-004', name: 'Nora Vance', department: 'Platform',
  influence: 71.2, collaboration: 50, expertise: 88, velocity: 50, quality: 50,
  composite: 82.5, trend: [0, 0, 0, 0, 0, 0, 0], scoredAt: '2026-08-01T00:00:00Z',
};
const AXES = { influence: 71, collaboration: 50, expertise: 88, velocity: 50, quality: 50 };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/scores', scoresRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(a)) fn.mockReset();
  historyMock.mockReset();
  analyzeMock.mockReset();
});

describe('GET /api/scores/leaderboard', () => {
  it('returns the entries envelope the leaderboard table reads', async () => {
    a['getLeaderboard']!.mockResolvedValue({
      entries: [ENTRY], total: 1, mostRecentScoredAt: '2026-08-01T00:00:00Z',
    });
    const res = await request(buildApp()).get('/api/scores/leaderboard');
    expect(res.status).toBe(200);
    // The three top-level keys are the contract; `total` is the count of the
    // rows it ships beside, never a separately-authored number.
    expect(Object.keys(res.body).sort()).toEqual(['entries', 'mostRecentScoredAt', 'total']);
    expect(res.body.total).toBe(res.body.entries.length);
    expect(res.body.entries[0]).toEqual(ENTRY);
  });

  it('defaults the limit to 12 and passes department through verbatim', async () => {
    a['getLeaderboard']!.mockResolvedValue({ entries: [], total: 0, mostRecentScoredAt: null });
    await request(buildApp()).get('/api/scores/leaderboard?department=Platform');
    expect(a['getLeaderboard']).toHaveBeenCalledWith({ department: 'Platform', limit: 12 });
  });

  it('serves an empty leaderboard as an empty list, not a 404', async () => {
    a['getLeaderboard']!.mockResolvedValue({ entries: [], total: 0, mostRecentScoredAt: null });
    const res = await request(buildApp()).get('/api/scores/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [], total: 0, mostRecentScoredAt: null });
  });

  it('falls back to the default when the limit is not a number', async () => {
    // Was a 500: NaN survived the provider's own clamp and built `LIMIT NaN`.
    // The route now clamps the way its /:personId/history sibling always did.
    a['getLeaderboard']!.mockResolvedValue({ entries: [], total: 0, mostRecentScoredAt: null });
    const res = await request(buildApp()).get('/api/scores/leaderboard?limit=abc');
    expect(res.status).toBe(200);
    const arg = a['getLeaderboard']!.mock.calls[0]![0] as { limit: number };
    expect(arg.limit).toBe(12);
  });
});

describe('GET /api/scores/skills', () => {
  it('returns the skill summaries as a bare array with mentionCount', async () => {
    a['getTopSkills']!.mockResolvedValue([{ id: 's-1', name: 'Kubernetes', mentionCount: 42 }]);
    const res = await request(buildApp()).get('/api/scores/skills');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toEqual({ id: 's-1', name: 'Kubernetes', mentionCount: 42 });
    expect(a['getTopSkills']).toHaveBeenCalledWith(30);
  });

  it('falls back to the default when the limit is not a number', async () => {
    a['getTopSkills']!.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/scores/skills?limit=abc');
    expect(res.status).toBe(200);
    expect(a['getTopSkills']).toHaveBeenCalledWith(30);
  });

  it('honours an explicit limit', async () => {
    a['getTopSkills']!.mockResolvedValue([]);
    await request(buildApp()).get('/api/scores/skills?limit=5');
    expect(a['getTopSkills']).toHaveBeenCalledWith(5);
  });
});

describe('GET /api/scores/by-skill', () => {
  it('400s with a named param when `skill` is missing', async () => {
    const res = await request(buildApp()).get('/api/scores/by-skill');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/skill/);
    expect(a['getSkillLeaderboard']).not.toHaveBeenCalled();
  });

  it('returns a leaderboard envelope for a named skill, default limit 25', async () => {
    a['getSkillLeaderboard']!.mockResolvedValue({ entries: [ENTRY], total: 1, mostRecentScoredAt: null });
    const res = await request(buildApp()).get('/api/scores/by-skill?skill=Kubernetes');
    expect(res.status).toBe(200);
    expect(a['getSkillLeaderboard']).toHaveBeenCalledWith({ skill: 'Kubernetes', limit: 25 });
    expect(res.body.entries[0].personId).toBe('p-004');
    expect(res.body.total).toBe(1);
  });
});

describe('GET /api/scores/cohorts', () => {
  it('ships the per-department stats with a five-bucket histogram', async () => {
    a['getCohorts']!.mockResolvedValue([{
      department: 'Platform', count: 3, medianComposite: 70, meanComposite: 71,
      compositeBuckets: [0, 0, 1, 1, 1], expertiseGini: 0.21,
      brokers: [{ id: 'p-004', name: 'Nora Vance', departmentsTouched: 3 }],
    }]);
    const res = await request(buildApp()).get('/api/scores/cohorts');
    expect(res.status).toBe(200);
    expect(res.body[0].compositeBuckets).toHaveLength(5);
    // The histogram has to account for every person the cohort claims.
    const summed = (res.body[0].compositeBuckets as number[]).reduce((x, y) => x + y, 0);
    expect(summed).toBe(res.body[0].count);
    expect(res.body[0].brokers[0]).toEqual({ id: 'p-004', name: 'Nora Vance', departmentsTouched: 3 });
  });
});

describe('GET /api/scores/radar (batch)', () => {
  it('resolves BEFORE /:personId/radar — the literal wins over the param', async () => {
    a['getRadarBatch']!.mockResolvedValue([{ personId: 'p-004', name: 'Nora Vance', person: AXES, peerMax: AXES }]);
    const res = await request(buildApp()).get('/api/scores/radar?ids=p-004');
    expect(res.status).toBe(200);
    // Ambiguity here would have called getPersonRadar('radar') instead.
    expect(a['getPersonRadar']).not.toHaveBeenCalled();
    expect(a['getRadarBatch']).toHaveBeenCalledWith(['p-004']);
    expect(res.body[0]).toEqual({ personId: 'p-004', name: 'Nora Vance', person: AXES, peerMax: AXES });
  });

  it('400s on a missing or blank ids param', async () => {
    for (const url of ['/api/scores/radar', '/api/scores/radar?ids=', '/api/scores/radar?ids=%20']) {
      const res = await request(buildApp()).get(url);
      expect(res.status).toBe(400);
    }
    expect(a['getRadarBatch']).not.toHaveBeenCalled();
  });

  it('400s above four ids and trims the CSV below it', async () => {
    const tooMany = await request(buildApp()).get('/api/scores/radar?ids=a,b,c,d,e');
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toMatch(/1 and 4/);

    a['getRadarBatch']!.mockResolvedValue([]);
    await request(buildApp()).get('/api/scores/radar?ids=%20a%20,b,,c');
    expect(a['getRadarBatch']).toHaveBeenCalledWith(['a', 'b', 'c']);
  });
});

describe('GET /api/scores/:personId/... ', () => {
  it('returns the radar axes envelope, and 404s an unscored person', async () => {
    a['getPersonRadar']!.mockResolvedValue({ personId: 'p-004', person: AXES, peerMax: AXES });
    const ok = await request(buildApp()).get('/api/scores/p-004/radar');
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body).sort()).toEqual(['peerMax', 'person', 'personId']);

    a['getPersonRadar']!.mockResolvedValue(null);
    const missing = await request(buildApp()).get('/api/scores/p-999/radar');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBeDefined();
  });

  it('returns contributions with all three evidence lists, and 404s when absent', async () => {
    a['getContributions']!.mockResolvedValue({
      personId: 'p-004', collaborators: [], projects: [], decisions: [],
    });
    const ok = await request(buildApp()).get('/api/scores/p-004/contributions');
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body).sort()).toEqual(['collaborators', 'decisions', 'personId', 'projects']);

    a['getContributions']!.mockResolvedValue(null);
    expect((await request(buildApp()).get('/api/scores/p-004/contributions')).status).toBe(404);
  });

  it('returns the score row, and 404s when the person has none', async () => {
    a['getScore']!.mockResolvedValue(ENTRY);
    const ok = await request(buildApp()).get('/api/scores/p-004');
    expect(ok.status).toBe(200);
    expect(ok.body.composite).toBe(82.5);
    expect(ok.body.trend).toHaveLength(7);

    a['getScore']!.mockResolvedValue(null);
    const missing = await request(buildApp()).get('/api/scores/p-999');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Score not found' });
  });
});

describe('GET /api/scores/:personId/history', () => {
  it('clamps days into 1..90 and defaults a non-numeric value to 30', async () => {
    historyMock.mockResolvedValue({ personId: 'p-004', samples: [], deltaVs7d: null });
    const app = buildApp();
    await request(app).get('/api/scores/p-004/history');
    await request(app).get('/api/scores/p-004/history?days=0');
    await request(app).get('/api/scores/p-004/history?days=900');
    await request(app).get('/api/scores/p-004/history?days=abc');
    expect(historyMock.mock.calls.map((c) => c[1])).toEqual([30, 1, 90, 30]);
  });

  it('degrades to an EMPTY history rather than erroring — and SAYS it did', async () => {
    // The samples table is created by a later migration than the route; a
    // throw here used to 500 the whole person drawer. Still 200 — but an
    // unmarked `samples: []` is a claim about the PERSON ("no score history"),
    // not about us, and a newly-scored person answers exactly that.
    historyMock.mockResolvedValue({ personId: 'p-004', samples: [], deltaVs7d: null });
    const newcomer = await request(buildApp()).get('/api/scores/p-004/history');
    expect(newcomer.body).toEqual({ personId: 'p-004', samples: [], deltaVs7d: null });

    historyMock.mockRejectedValue(new Error('relation "score_samples" does not exist'));
    const res = await request(buildApp()).get('/api/scores/p-004/history');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      personId: 'p-004', samples: [], deltaVs7d: null, degraded: true,
      error: 'relation "score_samples" does not exist',
    });
  });

  it('passes the provider payload through with its delta', async () => {
    historyMock.mockResolvedValue({
      personId: 'p-004',
      samples: [{ ts: '2026-08-01T00:00:00Z', score: 80 }],
      deltaVs7d: 2.5,
    });
    const res = await request(buildApp()).get('/api/scores/p-004/history?days=7');
    expect(res.body.samples[0]).toEqual({ ts: '2026-08-01T00:00:00Z', score: 80 });
    expect(res.body.deltaVs7d).toBe(2.5);
  });
});

describe('POST /api/scores/analysis', () => {
  it('returns the analysis payload', async () => {
    analyzeMock.mockResolvedValue({ weights: { expertise: 0.5 }, disagreements: [] });
    const res = await request(buildApp()).post('/api/scores/analysis').send({});
    expect(res.status).toBe(200);
    expect(res.body.weights.expertise).toBe(0.5);
  });

  it('503s (not 500) when the Code Interpreter session is unavailable, naming the cause', async () => {
    analyzeMock.mockRejectedValue(new Error('Code Interpreter not configured'));
    const res = await request(buildApp()).post('/api/scores/analysis').send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Code Interpreter not configured');
  });
});
